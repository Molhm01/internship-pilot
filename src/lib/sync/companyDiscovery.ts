import { prisma } from "@/lib/db";
import { listJobsForCompany } from "@/lib/ats";
import { detectAtsForCareersPage } from "@/lib/ats/detect";
import { getUsaJobsConfig, searchUsaJobs } from "@/lib/ats/usajobs";
import { ingestAtsJobs, upsertClassifiedAtsJob } from "@/lib/sync/ingest";
import { isTargetEngineeringRole } from "@/lib/sync/classify";
import { logAudit } from "@/lib/applications/audit";
import { canonicalizeSource, isDirectOfficialSource } from "@/lib/jobs/sourcePolicy";
import { promoteCanonicalDirectJob } from "@/lib/jobs/activeFeed";
import type { AtsJob } from "@/lib/ats/types";
import { reconcileOfficialBoardDelta } from "@/lib/sync/officialBoardDelta";
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

export async function checkCompany(companyId: string): Promise<CompanyCheckResult> {
  const startedAt = new Date();
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error("Company not found");

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
    const existingApproval = await prisma.approvedAtsTenant.findUnique({
      where: { companyId_atsType_atsIdentifier: { companyId, atsType, atsIdentifier } },
    });
    if (!existingApproval) {
      const confirmation = await detectAtsForCareersPage(company.careersUrl);
      if (
        confirmation.atsType === atsType
        && confirmation.atsIdentifier
        && equivalentConfiguredTenant(atsType, atsIdentifier, confirmation.atsIdentifier, company.careersUrl)
      ) {
        // Preserve an employer-page-proven shard-aware Workday identifier.
        if (atsType === "workday" && confirmation.atsIdentifier !== atsIdentifier) {
          atsIdentifier = confirmation.atsIdentifier;
        }
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
        await prisma.company.update({
          where: { id: companyId },
          data: { lastCheckedAt: new Date(), nextCheckAt: nextCheckTimeFor(effectivePriority(company, atsType), 0, atsType), lastCheckStatus: "unsupported" },
        });
        const durationMs = Date.now() - startedAt.getTime();
        await recordOfficialPoll({ companyId, companyName: company.name, provider: atsType ?? "unknown", startedAt, status: "unsupported", durationMs, configState: "UNTESTED", errorCode: "ATS_TENANT_UNCONFIRMED" });
        return { companyId, name: company.name, status: "unsupported", newCount: 0, updatedCount: 0, jobsScanned: 0, totalAvailableJobs: 0, engineeringInternshipsFound: 0, missingCount: 0, closedCount: 0, durationMs };
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
    const delta = supported && !notModified
      ? await reconcileOfficialBoardDelta({
          companyId,
          companyName: company.name,
          provider: atsType ?? "unknown",
          atsTenant: atsIdentifier,
          previousSnapshot: company.boardSnapshot,
          currentSourceJobIds: jobs.map((job) => job.sourceJobId),
        })
      : { newRequisitions: 0, missing: 0, closed: 0, reconciled: false };
    const durationMs = Date.now() - startedAt.getTime();
    // Quality SLOs describe the relevant jobs users can discover, not every
    // unrelated row returned by a broad provider search.
    const quality = postingQualityTelemetry(relevant, startedAt);
    const configState: AtsConfigState = supported
      ? (atsType === "custom" ? "CUSTOM" : "VALIDATED")
      : syntacticConfigState({ atsType, atsIdentifier, careersUrl: company.careersUrl });
    const activityTier = relevant.length > 0
      ? "A"
      : company.lastEngineeringInternshipAt
        ? "B"
        : "C";

    await prisma.company.update({
      where: { id: companyId },
      data: {
        atsType,
        atsIdentifier,
        lastCheckedAt: new Date(),
        nextCheckAt: nextCheckTimeFor(effectivePriority({ ...company, engineeringActivityTier: activityTier }, atsType), 0, atsType),
        ...(notModified ? {} : { activeInternshipCount: relevant.length }),
        lastCheckStatus: supported ? "success" : "unsupported",
        lastCheckError: null,
        consecutiveFailures: 0,
        lastBoardQueryMs: durationMs,
        atsConfigState: configState,
        atsConfigCheckedAt: new Date(),
        ...(configState === "VALIDATED" ? { atsValidatedAt: new Date() } : {}),
        atsConfigErrorCode: null,
        engineeringActivityTier: activityTier,
        ...(relevant.length > 0 ? { lastEngineeringInternshipAt: new Date() } : {}),
        ...(etag !== undefined ? { lastETag: etag } : {}),
        ...(lastModified !== undefined ? { lastModified } : {}),
        ...(contentHash !== undefined ? { contentHash } : {}),
      },
    });
    await recordOfficialPoll({
      companyId,
      companyName: company.name,
      provider: atsType ?? "unknown",
      startedAt,
      status: notModified ? "not_modified" : supported ? "success" : "unsupported",
      jobsScanned: jobs.length,
      totalAvailableJobs: totalAvailableJobs ?? jobs.length,
      engineeringInternshipsFound: relevant.length,
      newJobs: summary.newCount,
      updatedJobs: summary.updatedCount,
      missingJobs: delta.missing,
      closedJobs: delta.closed,
      durationMs,
      configState,
      paginationVerified: paginationVerified ?? false,
      ...quality,
    });

    return {
      companyId,
      name: company.name,
      status: supported ? "success" : "unsupported",
      newCount: summary.newCount,
      updatedCount: summary.updatedCount,
      jobsScanned: jobs.length,
      totalAvailableJobs: totalAvailableJobs ?? jobs.length,
      engineeringInternshipsFound: relevant.length,
      missingCount: delta.missing,
      closedCount: delta.closed,
      durationMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const consecutiveFailures = company.consecutiveFailures + 1;
    const failureCode = sanitizeErrorCode(err);
    const configState: AtsConfigState = ["ATS_HTTP_404", "ATS_HTTP_410", "ATS_SCHEMA_INVALID", "ATS_BOARD_UNREACHABLE"].includes(failureCode)
      ? "STALE"
      : failureCode === "ATS_CONFIG_MALFORMED"
        ? "MALFORMED"
        // A timeout, rate limit, or other transient fetch failure is not
        // evidence that a previously validated configuration became invalid.
        : company.atsConfigState === "VALIDATED" ? "VALIDATED" : "UNTESTED";
    await prisma.company.update({
      where: { id: companyId },
      data: {
        lastCheckedAt: new Date(),
        nextCheckAt: nextCheckTimeFor(effectivePriority(company, atsType), consecutiveFailures, atsType),
        lastCheckStatus: "error",
        lastCheckError: message,
        consecutiveFailures,
        atsConfigState: configState,
        atsConfigCheckedAt: new Date(),
        atsConfigErrorCode: failureCode,
      },
    });
    const durationMs = Date.now() - startedAt.getTime();
    await recordOfficialPoll({ companyId, companyName: company.name, provider: atsType ?? "unknown", startedAt, status: "error", durationMs, errorCode: failureCode, configState });
    return { companyId, name: company.name, status: "error", newCount: 0, updatedCount: 0, jobsScanned: 0, totalAvailableJobs: 0, engineeringInternshipsFound: 0, missingCount: 0, closedCount: 0, durationMs, error: message };
  }
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

async function recordOfficialPoll(args: {
  companyId: string;
  companyName: string;
  provider: string;
  startedAt: Date;
  status: "success" | "not_modified" | "unsupported" | "error";
  jobsScanned?: number;
  totalAvailableJobs?: number;
  engineeringInternshipsFound?: number;
  newJobs?: number;
  updatedJobs?: number;
  missingJobs?: number;
  closedJobs?: number;
  durationMs: number;
  errorCode?: string;
  configState?: AtsConfigState;
  paginationVerified?: boolean;
  fullJdJobs?: number;
  exactTimestampJobs?: number;
  dateOnlyJobs?: number;
  relativeParsedJobs?: number;
  radarFallbackJobs?: number;
  unknownTimestampJobs?: number;
}): Promise<void> {
  await prisma.officialBoardPoll.create({
    data: {
      ...args,
      finishedAt: new Date(),
      jobsScanned: args.jobsScanned ?? 0,
      totalAvailableJobs: args.totalAvailableJobs ?? args.jobsScanned ?? 0,
      engineeringInternshipsFound: args.engineeringInternshipsFound ?? 0,
      newJobs: args.newJobs ?? 0,
      updatedJobs: args.updatedJobs ?? 0,
      missingJobs: args.missingJobs ?? 0,
      closedJobs: args.closedJobs ?? 0,
      errorCode: args.errorCode ?? null,
      configState: args.configState ?? null,
      paginationVerified: args.paginationVerified ?? false,
      fullJdJobs: args.fullJdJobs ?? 0,
      exactTimestampJobs: args.exactTimestampJobs ?? 0,
      dateOnlyJobs: args.dateOnlyJobs ?? 0,
      relativeParsedJobs: args.relativeParsedJobs ?? 0,
      radarFallbackJobs: args.radarFallbackJobs ?? 0,
      unknownTimestampJobs: args.unknownTimestampJobs ?? 0,
    },
  }).catch(() => undefined);
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
 * One employer check that can never take the whole sweep with it.
 *
 * checkCompany catches errors from the employer's own board, but not from its
 * final bookkeeping write. A measured maintenance run lost an entire
 * 340-employer sweep to a single `prisma.company.update()` failing with
 * PostgreSQL 08P01 — a pooled-connection prepared-statement collision that has
 * nothing to do with the employer being checked. A sweep is a batch of
 * independent units of work, so one failing unit is recorded as a failure and
 * the rest continue.
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

export async function runCompanyDiscoveryBatch(limit = 5): Promise<{ checked: number; results: CompanyCheckResult[] }> {
  const candidates = await prisma.company.findMany({
    where: {
      monitoringStatus: "active",
      allowlisted: true,
      OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }],
    },
    take: 1000,
    select: {
      id: true,
      atsType: true,
      careersUrl: true,
      priority: true,
      csvEeCpeFit: true,
      engineeringActivityTier: true,
      nextCheckAt: true,
      lastCheckedAt: true,
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

  const results: CompanyCheckResult[] = [];
  for (const company of due) {
    await waitForDomainSlot(domainForRateLimit(company));
    results.push(await checkCompanySafely(company));
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
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
 * check updates lastCheckedAt.
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
    select: { id: true, atsType: true, careersUrl: true },
  });

  const results: CompanyCheckResult[] = [];
  for (let start = 0; start < companies.length; start += concurrency) {
    if (Date.now() - startedAt >= maxRuntimeMs) break;
    const wave = companies.slice(start, start + concurrency);
    const waveResults = await Promise.all(
      wave.map(async (company) => {
        await waitForDomainSlot(domainForRateLimit(company));
        return checkCompanySafely(company);
      }),
    );
    results.push(...waveResults);
  }

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
      id: true,
      atsType: true,
      careersUrl: true,
      priority: true,
      csvEeCpeFit: true,
      engineeringActivityTier: true,
      nextCheckAt: true,
      lastCheckedAt: true,
    },
  });

  const due = selectDueByTier(candidates, { tiers: options.tiers, limit, now: options.now });

  const results: CompanyCheckResult[] = [];
  for (let start = 0; start < due.length; start += concurrency) {
    if (Date.now() - startedAt >= maxRuntimeMs) break;
    const wave = due.slice(start, start + concurrency);
    const waveResults = await Promise.all(
      wave.map(async (company) => {
        await waitForDomainSlot(domainForRateLimit(company));
        return checkCompanySafely(company);
      }),
    );
    results.push(...waveResults);
  }

  return {
    checked: results.length,
    totalEligible: due.length,
    stoppedForTimeBudget: results.length < due.length,
    results,
  };
}
