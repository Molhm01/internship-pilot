import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { listJobsForCompany } from "@/lib/ats";
import { detectAtsForCareersPage } from "@/lib/ats/detect";
import { getUsaJobsConfig, searchUsaJobs } from "@/lib/ats/usajobs";
import { ingestAtsJobs, upsertClassifiedAtsJob } from "@/lib/sync/ingest";
import { isTargetEngineeringRole } from "@/lib/sync/classify";
import { logAudit } from "@/lib/applications/audit";
import { canonicalizeSource, isDirectOfficialSource } from "@/lib/jobs/sourcePolicy";
import { promoteCanonicalDirectJob } from "@/lib/jobs/activeFeed";
import type { AtsJob } from "@/lib/ats/types";
import { computeBoardDelta, type BoardDelta, type TrackedBoardJob } from "@/lib/sync/officialBoardDelta";
import { sanitizeErrorCode } from "@/lib/sync/atsIngest";
import {
  postingQualityTelemetry,
  syntacticConfigState,
  type AtsConfigState,
} from "@/lib/sync/officialDiscoveryMetrics";
import { parseWorkdayConfiguration } from "@/lib/ats/workday";

export type CompanyCheckResult = {
  companyId: string;
  name: string;
  status: "success" | "error" | "unsupported";
  newCount: number;
  updatedCount: number;
  jobsScanned: number;
  totalAvailableJobs: number;
  engineeringInternshipsFound: number;
  missingCount: number;
  closedCount: number;
  durationMs: number;
  error?: string;
};

export type CompanySweepResult = {
  checked: number;
  totalEligible: number;
  stoppedForTimeBudget: boolean;
  results: CompanyCheckResult[];
};

const MAX_BACKOFF_MINUTES = 24 * 60;

const CHEAP_PROVIDER = new Set([
  "greenhouse", "lever", "ashby", "smartrecruiters", "workday",
  "successfactors", "eightfold", "phenom",
]);

function baseIntervalMinutes(priority: string, provider?: string | null): number {
  const cheap = provider ? CHEAP_PROVIDER.has(provider) : false;
  if (priority === "priority") return cheap ? 5 + Math.floor(Math.random() * 6) : 60;
  if (priority === "low") return cheap ? 60 + Math.floor(Math.random() * 31) : 24 * 60;
  return cheap ? 20 + Math.floor(Math.random() * 11) : 6 * 60;
}

export function nextCheckTimeFor(priority: string, consecutiveFailures: number, provider?: string | null): Date {
  const base = baseIntervalMinutes(priority, provider);
  const minutes = consecutiveFailures > 0 ? Math.min(MAX_BACKOFF_MINUTES, base * 2 ** consecutiveFailures) : base;
  return new Date(Date.now() + minutes * 60 * 1000);
}

export function nextCheckTimeForFailure(
  priority: string,
  consecutiveFailures: number,
  provider: string | null | undefined,
  failureCode: string,
  now: Date = new Date(),
): Date {
  if (failureCode === "ATS_BOT_WALL") {
    const hours = Math.min(7 * 24, 12 * 2 ** Math.max(0, consecutiveFailures - 1));
    return new Date(now.getTime() + hours * 60 * 60 * 1000);
  }
  return nextCheckTimeFor(priority, consecutiveFailures, provider);
}

export function pollingTierFor(input: {
  priority: string;
  provider: string | null;
  eeCpeFit?: string | null;
  activityTier?: string | null;
}): "A" | "B" | "C" {
  if (!input.provider || !CHEAP_PROVIDER.has(input.provider)) return "C";
  if (["A", "B", "C"].includes(input.activityTier ?? "")) return input.activityTier as "A" | "B" | "C";
  if (input.priority === "priority" || input.eeCpeFit === "High") return "A";
  return "B";
}

function effectivePriority(company: { priority: string; csvEeCpeFit?: string | null; engineeringActivityTier?: string | null }, provider: string | null): string {
  const tier = pollingTierFor({ priority: company.priority, provider, eeCpeFit: company.csvEeCpeFit, activityTier: company.engineeringActivityTier });
  return tier === "A" ? "priority" : tier === "C" ? "low" : "standard";
}

/**
 * Direct employer/public-authority sources are written through the verified
 * direct-source path. Generic/custom scans keep the lower-trust path.
 *
 * Unchanged from before the batch-persistence refactor below: each relevant
 * job is a genuinely distinct write (different content, different
 * dedup/classification decision), so this stays per-job rather than being
 * folded into the wave-wide company bookkeeping batch. This is the
 * "operations per changed job" term in the wave-cost formula documented on
 * `runCompanyCheckWave` — proportional to real new/changed postings, not to
 * how many companies were merely checked.
 */
async function ingestDiscoveredJobs(
  jobs: AtsJob[],
  atsType: string | null | undefined,
  atsIdentifier: string | null | undefined,
  capturedAt: Date,
): Promise<{ newCount: number; updatedCount: number }> {
  const canonical = canonicalizeSource(atsType);
  if (!canonical || !isDirectOfficialSource(canonical)) {
    return ingestAtsJobs(jobs, atsType ? `ats:${atsType}` : "unknown", { capturedAt });
  }

  let newCount = 0;
  let updatedCount = 0;
  const tenant = atsIdentifier ?? canonical;

  for (const [rowIndex, job] of jobs.entries()) {
    const result = await upsertClassifiedAtsJob({
      job,
      source: canonical,
      atsType: canonical,
      atsTenant: tenant,
      classification: "QUALIFYING_INTERNSHIP",
      classificationReason:
        "Read from an official source and matched the engineering internship/co-op role filter.",
      rowIndex,
      capturedAt,
      syncRunId: `official-poll:${capturedAt.toISOString()}`,
    });

    // If this posting already existed only as an aggregator row, make the
    // direct employer/public-authority sighting the canonical provenance.
    await promoteCanonicalDirectJob(job, canonical, tenant);

    if (result === "new") newCount += 1;
    else if (result === "updated") updatedCount += 1;
  }

  return { newCount, updatedCount };
}

function equivalentConfiguredTenant(
  atsType: string,
  configured: string,
  detected: string,
  careersUrl: string | null,
): boolean {
  if (atsType !== "workday") return configured === detected;
  const left = parseWorkdayConfiguration(configured, careersUrl);
  const right = parseWorkdayConfiguration(detected, careersUrl);
  return Boolean(left && right && left.tenant === right.tenant && left.site === right.site);
}

// ---------------------------------------------------------------------------
// Batch-oriented company checking.
//
// This replaces a shape where every company check independently issued its
// own company.findUnique (redundant — the wave already fetched the row),
// approvedAtsTenant.findUnique, company.update, officialBoardPoll.create, and
// (when its board changed) a job.findMany + up to 4 job.updateMany calls for
// board-delta reconciliation — roughly 4-8 Prisma operations per company,
// every time, even when nothing about the company changed.
//
// The new shape: `checkCompanyPure` does all the network I/O and computation
// for one company and returns a `CompanyCheckOutcome` describing exactly what
// should be persisted, WITHOUT writing anything to the Company/
// OfficialBoardPoll/Job tables itself. `persistCompanyCheckResults` then
// writes the outcomes for an entire wave in a small, FIXED number of
// operations — a raw batch UPDATE for the Company rows, one createMany for
// OfficialBoardPoll telemetry, and up to four wave-wide job.updateMany calls
// for board-delta reconciliation — regardless of how many companies were in
// the wave. See `runCompanyCheckWave` for the documented cost formula.
//
// Two genuinely rare, per-company writes are deliberately NOT deferred:
// `approvedAtsTenant.create` (fires once, the first time a company's ATS
// tenant is newly confirmed — a real state change, not steady-state
// bookkeeping) and `logAudit` (fires only when a tenant fails confirmation).
// Both are already proportional to actual events, not to tick count.
// ---------------------------------------------------------------------------

export type CompanyRow = {
  id: string;
  name: string;
  atsType: string | null;
  atsIdentifier: string | null;
  careersUrl: string | null;
  priority: string;
  csvEeCpeFit: string | null;
  engineeringActivityTier: string | null;
  lastCheckedAt: Date | null;
  activeInternshipCount: number;
  consecutiveFailures: number;
  lastETag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  boardSnapshot: string | null;
  lastSuccessfulBoardAt: Date | null;
  atsConfigState: string;
  atsValidatedAt: Date | null;
  atsConfigErrorCode: string | null;
  atsConfigEvidence: string | null;
  lastEngineeringInternshipAt: Date | null;
  lastCheckStatus: string | null;
  lastCheckError: string | null;
  lastBoardQueryMs: number | null;
};

const COMPANY_ROW_SELECT = {
  id: true,
  name: true,
  atsType: true,
  atsIdentifier: true,
  careersUrl: true,
  priority: true,
  csvEeCpeFit: true,
  engineeringActivityTier: true,
  lastCheckedAt: true,
  activeInternshipCount: true,
  consecutiveFailures: true,
  lastETag: true,
  lastModified: true,
  contentHash: true,
  boardSnapshot: true,
  lastSuccessfulBoardAt: true,
  atsConfigState: true,
  atsValidatedAt: true,
  atsConfigErrorCode: true,
  atsConfigEvidence: true,
  lastEngineeringInternshipAt: true,
  lastCheckStatus: true,
  lastCheckError: true,
  lastBoardQueryMs: true,
} as const;

type CompanyUpdateFields = {
  companyId: string;
  atsType: string | null;
  atsIdentifier: string | null;
  lastCheckedAt: Date;
  nextCheckAt: Date;
  activeInternshipCount: number;
  lastCheckStatus: string;
  lastCheckError: string | null;
  consecutiveFailures: number;
  lastBoardQueryMs: number | null;
  atsConfigState: string;
  atsConfigCheckedAt: Date;
  atsValidatedAt: Date | null;
  atsConfigErrorCode: string | null;
  atsConfigEvidence: string | null;
  engineeringActivityTier: string;
  lastEngineeringInternshipAt: Date | null;
  lastETag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  boardSnapshot: string | null;
  lastSuccessfulBoardAt: Date | null;
};

type PollTelemetry = {
  companyId: string;
  companyName: string;
  provider: string;
  startedAt: Date;
  finishedAt: Date;
  status: "success" | "not_modified" | "unsupported" | "error";
  jobsScanned: number;
  totalAvailableJobs: number;
  engineeringInternshipsFound: number;
  newJobs: number;
  updatedJobs: number;
  missingJobs: number;
  closedJobs: number;
  durationMs: number;
  errorCode: string | null;
  configState: AtsConfigState | null;
  paginationVerified: boolean;
  fullJdJobs: number;
  exactTimestampJobs: number;
  dateOnlyJobs: number;
  relativeParsedJobs: number;
  radarFallbackJobs: number;
  unknownTimestampJobs: number;
};

type ReconciliationBuckets = {
  presentJobIds: string[];
  firstMissJobIds: string[];
  repeatedMissJobIds: string[];
  closeJobIds: string[];
};

export type CompanyCheckOutcome = {
  result: CompanyCheckResult;
  companyUpdate: CompanyUpdateFields;
  reconciliation: ReconciliationBuckets | null;
  pollTelemetry: PollTelemetry;
};

type TrackedBoardJobWithProvider = TrackedBoardJob & { atsType: string; atsTenant: string | null };

/** Everything a wave needs to know ahead of time, prefetched once instead of per company. */
export type CompanyCheckPrefetch = {
  /** `${companyId}|${atsType}|${atsIdentifier}` -> approval already exists. */
  approvedTenants: ReadonlySet<string>;
  /** Company name -> tracked QUALIFYING_INTERNSHIP jobs for board-delta reconciliation. */
  trackedJobsByCompany: ReadonlyMap<string, TrackedBoardJobWithProvider[]>;
};

function approvalKey(companyId: string, atsType: string, atsIdentifier: string): string {
  return `${companyId}|${atsType}|${atsIdentifier}`;
}

/** One shared prefetch for an entire wave of due companies. Two queries, regardless of wave size. */
export async function prefetchForCompanyCheckWave(companies: CompanyRow[]): Promise<CompanyCheckPrefetch> {
  if (companies.length === 0) {
    return { approvedTenants: new Set(), trackedJobsByCompany: new Map() };
  }
  const companyIds = companies.map((c) => c.id);
  const companyNames = [...new Set(companies.map((c) => c.name))];

  const [approvals, trackedRows] = await Promise.all([
    prisma.approvedAtsTenant.findMany({
      where: { companyId: { in: companyIds } },
      select: { companyId: true, atsType: true, atsIdentifier: true },
    }),
    prisma.job.findMany({
      where: { company: { in: companyNames }, classification: "QUALIFYING_INTERNSHIP" },
      select: { id: true, company: true, atsType: true, atsTenant: true, sourceJobId: true, consecutiveBoardMisses: true },
    }),
  ]);

  const approvedTenants = new Set(
    approvals.map((row) => approvalKey(row.companyId, row.atsType, row.atsIdentifier)),
  );

  const trackedJobsByCompany = new Map<string, TrackedBoardJobWithProvider[]>();
  for (const row of trackedRows) {
    const bucket = trackedJobsByCompany.get(row.company) ?? [];
    bucket.push({
      id: row.id,
      sourceJobId: row.sourceJobId,
      consecutiveBoardMisses: row.consecutiveBoardMisses,
      atsType: row.atsType ?? "",
      atsTenant: row.atsTenant,
    });
    trackedJobsByCompany.set(row.company, bucket);
  }

  return { approvedTenants, trackedJobsByCompany };
}

function reconciliationBucketsFor(
  companyName: string,
  provider: string,
  atsTenant: string | null,
  previousSnapshot: string | null,
  currentSourceJobIds: string[],
  prefetch: CompanyCheckPrefetch,
): { buckets: ReconciliationBuckets; delta: BoardDelta } | null {
  const deduped = [...new Set(currentSourceJobIds.filter(Boolean))].sort();
  if (deduped.length === 0) return null;

  const allTracked = prefetch.trackedJobsByCompany.get(companyName) ?? [];
  const trackedJobs = allTracked.filter(
    (job) => job.atsType === provider && (atsTenant ? job.atsTenant === atsTenant : true),
  );

  let previous: string[] = [];
  if (previousSnapshot) {
    try {
      const parsed = JSON.parse(previousSnapshot) as unknown;
      previous = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      previous = [];
    }
  }

  const delta = computeBoardDelta({
    previousSourceJobIds: previous,
    currentSourceJobIds: deduped,
    trackedJobs,
    successful: true,
  });

  const firstMissJobIds = trackedJobs
    .filter((job) => delta.missingJobIds.includes(job.id) && job.consecutiveBoardMisses === 0)
    .map((job) => job.id);
  const repeatedMissJobIds = delta.missingJobIds.filter((id) => !firstMissJobIds.includes(id));

  return {
    buckets: { presentJobIds: delta.presentJobIds, firstMissJobIds, repeatedMissJobIds, closeJobIds: delta.closeJobIds },
    delta,
  };
}

/**
 * Checks one company: all network I/O, all computation, and returns exactly
 * what should be persisted. Writes NOTHING to Company, OfficialBoardPoll, or
 * Job — see the module-level comment above for what stays as an immediate
 * write and why.
 */
export async function checkCompanyPure(
  company: CompanyRow,
  prefetch: CompanyCheckPrefetch,
): Promise<CompanyCheckOutcome> {
  const startedAt = new Date();
  const companyId = company.id;

  let atsType = company.atsType;
  let atsIdentifier = company.atsIdentifier;
  if ((!atsType || atsType === "unknown") && company.careersUrl) {
    const detected = await detectAtsForCareersPage(company.careersUrl);
    if (detected.atsType !== "unknown") {
      atsType = detected.atsType;
      atsIdentifier = detected.atsIdentifier;
    } else {
      atsType = "custom";
    }
  }

  if (atsType && atsType !== "unknown" && atsType !== "custom" && atsIdentifier && company.careersUrl) {
    const alreadyApproved = prefetch.approvedTenants.has(approvalKey(companyId, atsType, atsIdentifier));
    if (!alreadyApproved) {
      const confirmation = await detectAtsForCareersPage(company.careersUrl);
      if (
        confirmation.atsType === atsType
        && confirmation.atsIdentifier
        && equivalentConfiguredTenant(atsType, atsIdentifier, confirmation.atsIdentifier, company.careersUrl)
      ) {
        if (atsType === "workday" && confirmation.atsIdentifier !== atsIdentifier) {
          atsIdentifier = confirmation.atsIdentifier;
        }
        // Rare, one-time write: a company's ATS tenant confirmed for the
        // first time. Proportional to real state change, not to tick count.
        await prisma.approvedAtsTenant.create({
          data: {
            companyId,
            atsType,
            atsIdentifier,
            discoveredFromCareersUrl: company.careersUrl,
            evidence: JSON.stringify({ confirmedAt: new Date().toISOString(), method: "careers-page-crawl" }),
          },
        });
      } else {
        await logAudit({
          actor: "verification",
          action: "ats-tenant-unconfirmed",
          detail: `Could not independently confirm that ${company.name}'s own careers page (${company.careersUrl}) links to ${atsType}/${atsIdentifier} — skipping this check cycle rather than trusting an unverified tenant.`,
        });
        const durationMs = Date.now() - startedAt.getTime();
        return {
          result: {
            companyId, name: company.name, status: "unsupported", newCount: 0, updatedCount: 0,
            jobsScanned: 0, totalAvailableJobs: 0, engineeringInternshipsFound: 0, missingCount: 0, closedCount: 0, durationMs,
          },
          companyUpdate: {
            companyId, atsType: company.atsType, atsIdentifier: company.atsIdentifier,
            lastCheckedAt: new Date(), nextCheckAt: nextCheckTimeFor(effectivePriority(company, atsType), 0, atsType),
            activeInternshipCount: company.activeInternshipCount, lastCheckStatus: "unsupported",
            lastCheckError: company.lastCheckError, consecutiveFailures: company.consecutiveFailures,
            lastBoardQueryMs: company.lastBoardQueryMs, atsConfigState: company.atsConfigState,
            atsConfigCheckedAt: new Date(), atsValidatedAt: company.atsValidatedAt,
            atsConfigErrorCode: company.atsConfigErrorCode, atsConfigEvidence: company.atsConfigEvidence,
            engineeringActivityTier: company.engineeringActivityTier ?? "C",
            lastEngineeringInternshipAt: company.lastEngineeringInternshipAt,
            lastETag: company.lastETag, lastModified: company.lastModified, contentHash: company.contentHash,
            boardSnapshot: company.boardSnapshot, lastSuccessfulBoardAt: company.lastSuccessfulBoardAt,
          },
          reconciliation: null,
          pollTelemetry: {
            companyId, companyName: company.name, provider: atsType ?? "unknown", startedAt, finishedAt: new Date(),
            status: "unsupported", jobsScanned: 0, totalAvailableJobs: 0, engineeringInternshipsFound: 0,
            newJobs: 0, updatedJobs: 0, missingJobs: 0, closedJobs: 0, durationMs, errorCode: "ATS_TENANT_UNCONFIRMED",
            configState: "UNTESTED", paginationVerified: false, fullJdJobs: 0, exactTimestampJobs: 0, dateOnlyJobs: 0,
            relativeParsedJobs: 0, radarFallbackJobs: 0, unknownTimestampJobs: 0,
          },
        };
      }
    }
  }

  try {
    const { jobs, supported, notModified, etag, lastModified, contentHash, totalAvailableJobs, paginationVerified } = await listJobsForCompany({
      name: company.name,
      atsType,
      atsIdentifier,
      careersUrl: company.careersUrl,
      lastETag: company.lastETag,
      lastModified: company.lastModified,
      contentHash: company.contentHash,
    });

    const relevant = notModified ? [] : jobs.filter((j) => isTargetEngineeringRole(j.title, j.description));
    const summary = notModified
      ? { newCount: 0, updatedCount: 0 }
      : await ingestDiscoveredJobs(relevant, atsType, atsIdentifier, startedAt);

    const reconciliationOutcome = supported && !notModified
      ? reconciliationBucketsFor(company.name, atsType ?? "unknown", atsIdentifier, company.boardSnapshot, jobs.map((j) => j.sourceJobId), prefetch)
      : null;
    const delta = reconciliationOutcome?.delta ?? { newSourceJobIds: [], presentJobIds: [], missingJobIds: [], closeJobIds: [] };

    const durationMs = Date.now() - startedAt.getTime();
    const quality = postingQualityTelemetry(relevant, startedAt);
    const configState: AtsConfigState = supported
      ? (atsType === "custom" ? "CUSTOM" : "VALIDATED")
      : syntacticConfigState({ atsType, atsIdentifier, careersUrl: company.careersUrl });
    const activityTier = relevant.length > 0
      ? "A"
      : company.lastEngineeringInternshipAt
        ? "B"
        : "C";
    const now = new Date();

    return {
      result: {
        companyId, name: company.name, status: supported ? "success" : "unsupported",
        newCount: summary.newCount, updatedCount: summary.updatedCount, jobsScanned: jobs.length,
        totalAvailableJobs: totalAvailableJobs ?? jobs.length, engineeringInternshipsFound: relevant.length,
        missingCount: delta.missingJobIds.length, closedCount: delta.closeJobIds.length, durationMs,
      },
      companyUpdate: {
        companyId, atsType, atsIdentifier, lastCheckedAt: now,
        nextCheckAt: nextCheckTimeFor(effectivePriority({ ...company, engineeringActivityTier: activityTier }, atsType), 0, atsType),
        activeInternshipCount: notModified ? company.activeInternshipCount : relevant.length,
        lastCheckStatus: supported ? "success" : "unsupported", lastCheckError: null, consecutiveFailures: 0,
        lastBoardQueryMs: durationMs, atsConfigState: configState, atsConfigCheckedAt: now,
        atsValidatedAt: configState === "VALIDATED" ? now : company.atsValidatedAt,
        atsConfigErrorCode: null, atsConfigEvidence: company.atsConfigEvidence,
        engineeringActivityTier: activityTier,
        lastEngineeringInternshipAt: relevant.length > 0 ? now : company.lastEngineeringInternshipAt,
        lastETag: etag !== undefined ? etag : company.lastETag,
        lastModified: lastModified !== undefined ? lastModified : company.lastModified,
        contentHash: contentHash !== undefined ? contentHash : company.contentHash,
        boardSnapshot: reconciliationOutcome ? JSON.stringify([...new Set(jobs.map((j) => j.sourceJobId).filter(Boolean))].sort()) : company.boardSnapshot,
        lastSuccessfulBoardAt: reconciliationOutcome ? now : company.lastSuccessfulBoardAt,
      },
      reconciliation: reconciliationOutcome?.buckets ?? null,
      pollTelemetry: {
        companyId, companyName: company.name, provider: atsType ?? "unknown", startedAt, finishedAt: now,
        status: notModified ? "not_modified" : supported ? "success" : "unsupported",
        jobsScanned: jobs.length, totalAvailableJobs: totalAvailableJobs ?? jobs.length,
        engineeringInternshipsFound: relevant.length, newJobs: summary.newCount, updatedJobs: summary.updatedCount,
        missingJobs: delta.missingJobIds.length, closedJobs: delta.closeJobIds.length, durationMs,
        errorCode: null, configState, paginationVerified: paginationVerified ?? false, ...quality,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const consecutiveFailures = company.consecutiveFailures + 1;
    const failureCode = sanitizeErrorCode(err);
    const configState: AtsConfigState = ["ATS_HTTP_404", "ATS_HTTP_410", "ATS_SCHEMA_INVALID", "ATS_BOARD_UNREACHABLE"].includes(failureCode)
      ? "STALE"
      : failureCode === "ATS_CONFIG_MALFORMED"
        ? "MALFORMED"
        : company.atsConfigState === "VALIDATED" ? "VALIDATED" : "UNTESTED";
    const now = new Date();
    const durationMs = Date.now() - startedAt.getTime();
    return {
      result: {
        companyId, name: company.name, status: "error", newCount: 0, updatedCount: 0, jobsScanned: 0,
        totalAvailableJobs: 0, engineeringInternshipsFound: 0, missingCount: 0, closedCount: 0, durationMs, error: message,
      },
      companyUpdate: {
        companyId, atsType: company.atsType, atsIdentifier: company.atsIdentifier, lastCheckedAt: now,
        nextCheckAt: nextCheckTimeForFailure(effectivePriority(company, atsType), consecutiveFailures, atsType, failureCode),
        activeInternshipCount: company.activeInternshipCount, lastCheckStatus: "error", lastCheckError: message,
        consecutiveFailures, lastBoardQueryMs: company.lastBoardQueryMs, atsConfigState: configState, atsConfigCheckedAt: now,
        atsValidatedAt: company.atsValidatedAt, atsConfigErrorCode: failureCode,
        atsConfigEvidence: failureCode === "ATS_BOT_WALL"
          ? JSON.stringify({ access: "BOT_WALL", observedAt: now.toISOString(), action: "STOP_AND_BACKOFF" })
          : company.atsConfigEvidence,
        engineeringActivityTier: company.engineeringActivityTier ?? "C",
        lastEngineeringInternshipAt: company.lastEngineeringInternshipAt,
        lastETag: company.lastETag, lastModified: company.lastModified, contentHash: company.contentHash,
        boardSnapshot: company.boardSnapshot, lastSuccessfulBoardAt: company.lastSuccessfulBoardAt,
      },
      reconciliation: null,
      pollTelemetry: {
        companyId, companyName: company.name, provider: atsType ?? "unknown", startedAt, finishedAt: now,
        status: "error", jobsScanned: 0, totalAvailableJobs: 0, engineeringInternshipsFound: 0, newJobs: 0,
        updatedJobs: 0, missingJobs: 0, closedJobs: 0, durationMs, errorCode: failureCode, configState,
        paginationVerified: false, fullJdJobs: 0, exactTimestampJobs: 0, dateOnlyJobs: 0, relativeParsedJobs: 0,
        radarFallbackJobs: 0, unknownTimestampJobs: 0,
      },
    };
  }
}

/** try/catch wrapper around `checkCompanyPure`, mirroring `checkCompanySafely` below for the batch path. */
async function checkCompanyPureSafely(company: CompanyRow, prefetch: CompanyCheckPrefetch): Promise<CompanyCheckOutcome> {
  try {
    return await checkCompanyPure(company, prefetch);
  } catch (error) {
    const now = new Date();
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    return {
      result: {
        companyId: company.id, name: company.name, status: "error", newCount: 0, updatedCount: 0, jobsScanned: 0,
        totalAvailableJobs: 0, engineeringInternshipsFound: 0, missingCount: 0, closedCount: 0, durationMs: 0, error: message,
      },
      companyUpdate: {
        companyId: company.id, atsType: company.atsType, atsIdentifier: company.atsIdentifier, lastCheckedAt: now,
        nextCheckAt: nextCheckTimeForFailure(effectivePriority(company, company.atsType), company.consecutiveFailures + 1, company.atsType, "UNKNOWN"),
        activeInternshipCount: company.activeInternshipCount, lastCheckStatus: "error", lastCheckError: message,
        consecutiveFailures: company.consecutiveFailures + 1, lastBoardQueryMs: company.lastBoardQueryMs,
        atsConfigState: company.atsConfigState, atsConfigCheckedAt: now, atsValidatedAt: company.atsValidatedAt,
        atsConfigErrorCode: "UNKNOWN", atsConfigEvidence: company.atsConfigEvidence,
        engineeringActivityTier: company.engineeringActivityTier ?? "C", lastEngineeringInternshipAt: company.lastEngineeringInternshipAt,
        lastETag: company.lastETag, lastModified: company.lastModified, contentHash: company.contentHash,
        boardSnapshot: company.boardSnapshot, lastSuccessfulBoardAt: company.lastSuccessfulBoardAt,
      },
      reconciliation: null,
      pollTelemetry: {
        companyId: company.id, companyName: company.name, provider: company.atsType ?? "unknown", startedAt: now, finishedAt: now,
        status: "error", jobsScanned: 0, totalAvailableJobs: 0, engineeringInternshipsFound: 0, newJobs: 0, updatedJobs: 0,
        missingJobs: 0, closedJobs: 0, durationMs: 0, errorCode: "UNKNOWN", configState: null, paginationVerified: false,
        fullJdJobs: 0, exactTimestampJobs: 0, dateOnlyJobs: 0, relativeParsedJobs: 0, radarFallbackJobs: 0, unknownTimestampJobs: 0,
      },
    };
  }
}

function companyUpdateValuesRow(u: CompanyUpdateFields) {
  return Prisma.sql`(${u.companyId}::text, ${u.atsType}::text, ${u.atsIdentifier}::text, ${u.lastCheckedAt}::timestamptz, ${u.nextCheckAt}::timestamptz, ${u.activeInternshipCount}::int, ${u.lastCheckStatus}::text, ${u.lastCheckError}::text, ${u.consecutiveFailures}::int, ${u.lastBoardQueryMs}::int, ${u.atsConfigState}::text, ${u.atsConfigCheckedAt}::timestamptz, ${u.atsValidatedAt}::timestamptz, ${u.atsConfigErrorCode}::text, ${u.atsConfigEvidence}::text, ${u.engineeringActivityTier}::text, ${u.lastEngineeringInternshipAt}::timestamptz, ${u.lastETag}::text, ${u.lastModified}::text, ${u.contentHash}::text, ${u.boardSnapshot}::text, ${u.lastSuccessfulBoardAt}::timestamptz)`;
}

/**
 * Writes every Company row in the wave in ONE statement.
 *
 * `updateMany` cannot express this: each company gets different values for
 * the same columns. Postgres's `UPDATE ... FROM (VALUES ...)` is the
 * standard, safe way to do a heterogeneous multi-row update in one round
 * trip — every value is passed as a bound parameter (Prisma.sql's tagged
 * template), never string-interpolated, and every column is explicitly cast
 * so Postgres never has to guess a VALUES column's type from a batch where
 * every row happens to be NULL for that column.
 */
async function persistCompanyUpdatesBatch(updates: CompanyUpdateFields[]): Promise<void> {
  if (updates.length === 0) return;
  const rows = Prisma.join(updates.map(companyUpdateValuesRow));
  await prisma.$executeRaw`
    UPDATE "Company" AS c SET
      "atsType" = v.ats_type,
      "atsIdentifier" = v.ats_identifier,
      "lastCheckedAt" = v.last_checked_at,
      "nextCheckAt" = v.next_check_at,
      "activeInternshipCount" = v.active_internship_count,
      "lastCheckStatus" = v.last_check_status,
      "lastCheckError" = v.last_check_error,
      "consecutiveFailures" = v.consecutive_failures,
      "lastBoardQueryMs" = v.last_board_query_ms,
      "atsConfigState" = v.ats_config_state,
      "atsConfigCheckedAt" = v.ats_config_checked_at,
      "atsValidatedAt" = v.ats_validated_at,
      "atsConfigErrorCode" = v.ats_config_error_code,
      "atsConfigEvidence" = v.ats_config_evidence,
      "engineeringActivityTier" = v.engineering_activity_tier,
      "lastEngineeringInternshipAt" = v.last_engineering_internship_at,
      "lastETag" = v.last_etag,
      "lastModified" = v.last_modified,
      "contentHash" = v.content_hash,
      "boardSnapshot" = v.board_snapshot,
      "lastSuccessfulBoardAt" = v.last_successful_board_at,
      "updatedAt" = now()
    FROM (VALUES ${rows}) AS v(
      company_id, ats_type, ats_identifier, last_checked_at, next_check_at, active_internship_count,
      last_check_status, last_check_error, consecutive_failures, last_board_query_ms, ats_config_state,
      ats_config_checked_at, ats_validated_at, ats_config_error_code, ats_config_evidence,
      engineering_activity_tier, last_engineering_internship_at, last_etag, last_modified, content_hash,
      board_snapshot, last_successful_board_at
    )
    WHERE c.id = v.company_id
  `;
}

/**
 * Persists an entire wave of `checkCompanyPure` outcomes in a fixed, small
 * number of operations, regardless of how many companies were checked:
 *   1. One raw batch UPDATE for every Company row (see above).
 *   2. One `createMany` for every OfficialBoardPoll telemetry row.
 *   3. Up to four wave-wide `job.updateMany` calls for board-delta
 *      reconciliation — every company's present/first-miss/repeated-miss/
 *      close job IDs are unioned into one list per bucket before writing,
 *      since the update DATA for each bucket is identical across companies
 *      (only the ID set differs), which is exactly what `updateMany`'s
 *      `id: { in: [...] }` is for.
 * Per-changed-job writes (new/updated postings) already happened inside
 * `checkCompanyPure` via `ingestDiscoveredJobs`, proportional to real
 * content changes — this function only handles the fixed bookkeeping.
 */
export async function persistCompanyCheckResults(outcomes: CompanyCheckOutcome[]): Promise<void> {
  if (outcomes.length === 0) return;

  const now = new Date();
  const present: string[] = [];
  const firstMiss: string[] = [];
  const repeatedMiss: string[] = [];
  const closed: string[] = [];
  for (const outcome of outcomes) {
    if (!outcome.reconciliation) continue;
    present.push(...outcome.reconciliation.presentJobIds);
    firstMiss.push(...outcome.reconciliation.firstMissJobIds);
    repeatedMiss.push(...outcome.reconciliation.repeatedMissJobIds);
    closed.push(...outcome.reconciliation.closeJobIds);
  }

  await Promise.all([
    persistCompanyUpdatesBatch(outcomes.map((o) => o.companyUpdate)),
    prisma.officialBoardPoll.createMany({ data: outcomes.map((o) => o.pollTelemetry) }),
    present.length > 0
      ? prisma.job.updateMany({ where: { id: { in: present } }, data: { consecutiveBoardMisses: 0, boardMissingSince: null } })
      : Promise.resolve(),
    firstMiss.length > 0
      ? prisma.job.updateMany({ where: { id: { in: firstMiss } }, data: { consecutiveBoardMisses: { increment: 1 }, boardMissingSince: now } })
      : Promise.resolve(),
    repeatedMiss.length > 0
      ? prisma.job.updateMany({ where: { id: { in: repeatedMiss } }, data: { consecutiveBoardMisses: { increment: 1 } } })
      : Promise.resolve(),
    closed.length > 0
      ? prisma.job.updateMany({
          where: { id: { in: closed } },
          data: {
            verificationStatus: "Closed",
            reasonCode: "OFFICIAL_POSTING_REMOVED",
            verificationReason: "Absent from two consecutive successful official board snapshots.",
            classification: "CONFIRMED_CLOSED",
            classificationReason: "Removed from the official employer board after repeated successful checks.",
            activeFeed: false,
            closedAt: now,
          },
        })
      : Promise.resolve(),
  ]);
}

/**
 * Single-company entry point — the admin "check now" route
 * (`/api/companies/[id]/check`) and nothing else. Fetches its own prefetch
 * (wave of one) and persists immediately; there is no cross-company batching
 * to gain from a single check, so this is the simplest correct path, not a
 * shortcut around the batch architecture above.
 */
export async function checkCompany(companyId: string): Promise<CompanyCheckResult> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: COMPANY_ROW_SELECT });
  if (!company) throw new Error("Company not found");
  const prefetch = await prefetchForCompanyCheckWave([company]);
  const outcome = await checkCompanyPure(company, prefetch);
  await persistCompanyCheckResults([outcome]);
  return outcome.result;
}

/**
 * One employer check that can never take the whole sweep with it.
 *
 * Kept for compatibility — src/lib/cron/lane.test.ts exercises this directly
 * with a synthetic `check` function, and it remains a valid generic
 * "never let one item's exception break the batch" wrapper around anything
 * shaped like `(companyId) => Promise<CompanyCheckResult>`, including the
 * single-company `checkCompany` above.
 */
export async function checkCompanySafely(
  company: { id: string; name?: string },
  check: (companyId: string) => Promise<CompanyCheckResult> = checkCompany,
): Promise<CompanyCheckResult> {
  try {
    return await check(company.id);
  } catch (error) {
    return {
      companyId: company.id,
      name: company.name ?? company.id,
      status: "error",
      newCount: 0,
      updatedCount: 0,
      jobsScanned: 0,
      totalAvailableJobs: 0,
      engineeringInternshipsFound: 0,
      missingCount: 0,
      closedCount: 0,
      durationMs: 0,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    };
  }
}

const ATS_API_DOMAINS: Record<string, string> = {
  greenhouse: "boards-api.greenhouse.io",
  lever: "api.lever.co",
  ashby: "api.ashbyhq.com",
  smartrecruiters: "api.smartrecruiters.com",
  workday: "myworkdayjobs.com",
};
const MIN_MS_BETWEEN_SAME_DOMAIN_REQUESTS = 1500;
const nextSlotAtByDomain = new Map<string, number>();

function domainForRateLimit(company: { atsType: string | null; careersUrl: string | null }): string {
  if (company.atsType && ATS_API_DOMAINS[company.atsType]) return ATS_API_DOMAINS[company.atsType];
  if (company.careersUrl) {
    try {
      return new URL(company.careersUrl).hostname;
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}

/** Reserve request start slots synchronously so concurrent workers still honor
 * the minimum delay for companies already known to share one ATS API domain. */
async function waitForDomainSlot(domain: string): Promise<void> {
  const now = Date.now();
  const slotAt = Math.max(now, nextSlotAtByDomain.get(domain) ?? now);
  nextSlotAtByDomain.set(domain, slotAt + MIN_MS_BETWEEN_SAME_DOMAIN_REQUESTS);
  const delay = slotAt - now;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Checks a batch of companies concurrently (respecting per-domain pacing)
 * against an ALREADY-PREFETCHED index, without persisting anything.
 *
 * Split out from `runCompanyCheckWave` so a multi-wave caller
 * (`runCompanyDiscoverySweep`, `runTieredDuePoll`) can prefetch once and
 * persist once for an entire run of many waves, instead of once per wave —
 * see those functions' own cost-formula documentation for why that matters
 * at maintenance-sweep scale.
 */
async function checkCompaniesWithPrefetch(
  companies: CompanyRow[],
  prefetch: CompanyCheckPrefetch,
): Promise<CompanyCheckOutcome[]> {
  return Promise.all(
    companies.map(async (company) => {
      await waitForDomainSlot(domainForRateLimit(company));
      return checkCompanyPureSafely(company, prefetch);
    }),
  );
}

/**
 * Checks one wave of companies concurrently (respecting per-domain pacing)
 * and persists that wave in one batch — see `persistCompanyCheckResults`.
 *
 * Cost formula for a wave of N companies where C of them actually changed
 * something (new/updated/closed postings):
 *   Prisma operations ≈ FIXED_WAVE_OPS + (ops per changed job × jobs changed)
 * where FIXED_WAVE_OPS is small and constant regardless of N:
 *   1 (prefetch approvedTenants) + 1 (prefetch trackedJobs) +
 *   1 (batch Company update) + 1 (officialBoardPoll createMany) +
 *   up to 4 (wave-wide job.updateMany for board-delta reconciliation,
 *   0 when nothing to reconcile) ≈ 3-8 operations total for the wave.
 * Per-company operations for a company with nothing new: 0 — its check is
 * pure network I/O plus in-memory computation until the batch persist above.
 * Per-changed-job operations: ~2-3 (upsertClassifiedAtsJob +
 * promoteCanonicalDirectJob), proportional to real new/updated postings, not
 * to how many companies were merely checked.
 *
 * Used directly by `runCompanyDiscoveryBatch` (a single wave). Multi-wave
 * callers use `checkCompaniesWithPrefetch` + one shared persist instead — see
 * `runCompanyDiscoverySweep` / `runTieredDuePoll`.
 */
export async function runCompanyCheckWave(companies: CompanyRow[]): Promise<CompanyCheckResult[]> {
  if (companies.length === 0) return [];
  const prefetch = await prefetchForCompanyCheckWave(companies);
  const outcomes = await checkCompaniesWithPrefetch(companies, prefetch);
  await persistCompanyCheckResults(outcomes);
  return outcomes.map((o) => o.result);
}

export async function runCompanyDiscoveryBatch(limit = 5): Promise<{ checked: number; results: CompanyCheckResult[] }> {
  const candidates = await prisma.company.findMany({
    where: {
      monitoringStatus: "active",
      allowlisted: true,
      OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }],
    },
    take: 1000,
    select: {
      ...COMPANY_ROW_SELECT,
      nextCheckAt: true,
    },
  });
  const tierRank = { A: 0, B: 1, C: 2 } as const;
  const time = (value: Date | null) => value?.getTime() ?? 0;
  const due = candidates
    .sort((left, right) => {
      const leftTier = pollingTierFor({ priority: left.priority, provider: left.atsType, eeCpeFit: left.csvEeCpeFit, activityTier: left.engineeringActivityTier });
      const rightTier = pollingTierFor({ priority: right.priority, provider: right.atsType, eeCpeFit: right.csvEeCpeFit, activityTier: right.engineeringActivityTier });
      return tierRank[leftTier] - tierRank[rightTier]
        || time(left.nextCheckAt) - time(right.nextCheckAt)
        || time(left.lastCheckedAt) - time(right.lastCheckedAt);
    })
    .slice(0, limit);

  const results = await runCompanyCheckWave(due);
  return { checked: results.length, results };
}

/**
 * Hosted/manual full-registry sweep.
 *
 * Unlike the local priority scheduler, this deliberately ignores nextCheckAt
 * and starts with employers that have never been checked, followed by the
 * least-recently checked employers. Work is processed in concurrent waves and
 * stops before the caller's serverless time budget is exhausted. The next run
 * naturally resumes with the oldest remaining employers because every company
 * check updates lastCheckedAt. The whole sweep — every wave — is
 * persisted in one batch after the wave loop ends (see the cost-formula
 * comment on the function below), whether the loop completed or stopped
 * early for the time budget; stopping early never loses already-computed
 * work, it just means fewer outcomes are in that one batch.
 */
/**
 * Cost formula for a whole sweep of W waves covering N companies total
 * (this is the shape maintenance uses, where N can be up to 1000):
 *   Prisma operations ≈ FIXED_SWEEP_OPS + (ops per changed job × jobs changed)
 * where FIXED_SWEEP_OPS is small and constant regardless of N or W — the
 * prefetch and the persist below each run exactly ONCE for the entire sweep,
 * not once per wave:
 *   1 (due-company fetch) + 1 (prefetch approvedTenants) +
 *   1 (prefetch trackedJobs) + 1 (batch Company update) +
 *   1 (officialBoardPoll createMany) + up to 4 (wave-wide job.updateMany for
 *   board-delta reconciliation) ≈ 5-9 operations for the WHOLE sweep, whether
 *   it processes 5 companies or 1000. This is what keeps a full maintenance
 *   sweep's ATS-polling cost from scaling with catalog size or wave count.
 */
export async function runCompanyDiscoverySweep(options: {
  limit?: number;
  concurrency?: number;
  maxRuntimeMs?: number;
} = {}): Promise<CompanySweepResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 1000, 1000));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 10, 20));
  const maxRuntimeMs = Math.max(30_000, Math.min(options.maxRuntimeMs ?? 180_000, 240_000));
  const startedAt = Date.now();

  const companies = await prisma.company.findMany({
    where: { monitoringStatus: "active", allowlisted: true },
    orderBy: [
      { lastCheckedAt: { sort: "asc", nulls: "first" } },
      { name: "asc" },
    ],
    take: limit,
    select: COMPANY_ROW_SELECT,
  });

  const prefetch = await prefetchForCompanyCheckWave(companies);
  const outcomes: CompanyCheckOutcome[] = [];
  for (let start = 0; start < companies.length; start += concurrency) {
    if (Date.now() - startedAt >= maxRuntimeMs) break;
    const wave = companies.slice(start, start + concurrency);
    outcomes.push(...(await checkCompaniesWithPrefetch(wave, prefetch)));
  }
  // Persisted once for the whole sweep — including whatever was completed
  // before an early stop for the time budget, so nothing already checked is
  // ever lost, exactly as the previous per-wave persistence guaranteed.
  await persistCompanyCheckResults(outcomes);
  const results = outcomes.map((o) => o.result);

  return {
    checked: results.length,
    totalEligible: companies.length,
    stoppedForTimeBudget: results.length < companies.length,
    results,
  };
}

const USAJOBS_KEYWORDS = [
  "electrical engineering intern",
  "computer engineering intern",
  "electronics engineering intern",
  "mechanical engineering intern",
  "systems engineering intern",
  "engineering technician intern",
];

export async function runUsaJobsDiscovery(): Promise<{
  configured: boolean;
  newCount: number;
  updatedCount: number;
}> {
  const config = getUsaJobsConfig();
  if (!config) return { configured: false, newCount: 0, updatedCount: 0 };

  let newCount = 0;
  let updatedCount = 0;
  for (const keyword of USAJOBS_KEYWORDS) {
    const jobs = await searchUsaJobs(keyword, config);
    const relevant = jobs.filter((j) => isTargetEngineeringRole(j.title, j.description));
    const summary = await ingestDiscoveredJobs(relevant, "usajobs", "usajobs", new Date());
    newCount += summary.newCount;
    updatedCount += summary.updatedCount;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { configured: true, newCount, updatedCount };
}

// ---------------------------------------------------------------------------
// Tiered, due-based polling — the lane the hosted fresh cron uses
// ---------------------------------------------------------------------------

export type PollingTier = "A" | "B" | "C";

export type TieredPollCandidate = {
  id: string;
  atsType: string | null;
  careersUrl: string | null;
  priority: string;
  csvEeCpeFit: string | null;
  engineeringActivityTier: string | null;
  nextCheckAt: Date | null;
  lastCheckedAt: Date | null;
};

/**
 * Which employers a tiered lane should poll right now.
 *
 * Pure so the lane's selection is testable without a database. Two rules:
 * only employers whose backoff has actually elapsed are eligible (otherwise a
 * five-minute cron would hammer the same boards forever), and the requested
 * tiers bound the work so the fresh lane never inherits the slow custom-scan
 * tail that belongs to maintenance.
 */
export function selectDueByTier(
  candidates: TieredPollCandidate[],
  options: { tiers: PollingTier[]; limit: number; now?: Date },
): TieredPollCandidate[] {
  const now = (options.now ?? new Date()).getTime();
  const wanted = new Set(options.tiers);
  const tierRank: Record<PollingTier, number> = { A: 0, B: 1, C: 2 };
  const time = (value: Date | null) => value?.getTime() ?? 0;

  const tierOf = (candidate: TieredPollCandidate): PollingTier =>
    pollingTierFor({
      priority: candidate.priority,
      provider: candidate.atsType,
      eeCpeFit: candidate.csvEeCpeFit,
      activityTier: candidate.engineeringActivityTier,
    });

  return candidates
    .filter((candidate) => wanted.has(tierOf(candidate)))
    .filter((candidate) => candidate.nextCheckAt === null || candidate.nextCheckAt.getTime() <= now)
    .sort(
      (left, right) =>
        tierRank[tierOf(left)] - tierRank[tierOf(right)] ||
        time(left.nextCheckAt) - time(right.nextCheckAt) ||
        time(left.lastCheckedAt) - time(right.lastCheckedAt),
    )
    .slice(0, Math.max(0, options.limit));
}

/**
 * Polls only the employers of the requested tiers whose next check is due,
 * inside a hard runtime budget. This is what makes a five-minute hosted lane
 * possible: it does bounded, incremental work rather than a whole-registry
 * sweep, and it stops itself well before the platform's function timeout.
 * The whole poll — every wave — is persisted in one batch after the wave
 * loop ends; see runCompanyDiscoverySweep's cost-formula comment for the
 * same reasoning applied here.
 */
export async function runTieredDuePoll(options: {
  tiers: PollingTier[];
  limit?: number;
  concurrency?: number;
  maxRuntimeMs?: number;
  now?: Date;
}): Promise<CompanySweepResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 40, 400));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 6, 20));
  const maxRuntimeMs = Math.max(5_000, Math.min(options.maxRuntimeMs ?? 45_000, 240_000));
  const startedAt = Date.now();

  const candidates = await prisma.company.findMany({
    where: {
      monitoringStatus: "active",
      allowlisted: true,
      OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: options.now ?? new Date() } }],
    },
    take: 2000,
    select: {
      ...COMPANY_ROW_SELECT,
      nextCheckAt: true,
    },
  });

  // selectDueByTier's return type is narrowed to TieredPollCandidate (its own
  // small, pure/testable contract) — map back to the full CompanyRow objects
  // already fetched above rather than re-fetching by id.
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const due = selectDueByTier(candidates, { tiers: options.tiers, limit, now: options.now })
    .map((candidate) => candidateById.get(candidate.id))
    .filter((candidate): candidate is (typeof candidates)[number] => Boolean(candidate));

  // Prefetched and persisted once for the whole tiered poll — see
  // runCompanyDiscoverySweep's cost-formula comment above; the same
  // reasoning applies here.
  const prefetch = await prefetchForCompanyCheckWave(due);
  const outcomes: CompanyCheckOutcome[] = [];
  for (let start = 0; start < due.length; start += concurrency) {
    if (Date.now() - startedAt >= maxRuntimeMs) break;
    const wave = due.slice(start, start + concurrency);
    outcomes.push(...(await checkCompaniesWithPrefetch(wave, prefetch)));
  }
  await persistCompanyCheckResults(outcomes);
  const results = outcomes.map((o) => o.result);

  return {
    checked: results.length,
    totalEligible: due.length,
    stoppedForTimeBudget: results.length < due.length,
    results,
  };
}
