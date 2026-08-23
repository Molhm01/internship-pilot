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

export type CompanyCheckResult = {
  companyId: string;
  name: string;
  status: "success" | "error" | "unsupported";
  newCount: number;
  updatedCount: number;
  jobsScanned: number;
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
  if (priority === "low") return 24 * 60;
  return cheap ? 20 + Math.floor(Math.random() * 41) : 6 * 60;
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
}): "A" | "B" | "C" {
  if (!input.provider || !CHEAP_PROVIDER.has(input.provider)) return "C";
  if (input.priority === "priority" || input.eeCpeFit === "High") return "A";
  return "B";
}

function effectivePriority(company: { priority: string; csvEeCpeFit?: string | null }, provider: string | null): string {
  const tier = pollingTierFor({ priority: company.priority, provider, eeCpeFit: company.csvEeCpeFit });
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
): Promise<{ newCount: number; updatedCount: number }> {
  const canonical = canonicalizeSource(atsType);
  if (!canonical || !isDirectOfficialSource(canonical)) {
    return ingestAtsJobs(jobs, atsType ? `ats:${atsType}` : "unknown");
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
      if (confirmation.atsType === atsType && confirmation.atsIdentifier === atsIdentifier) {
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
        await recordOfficialPoll({ companyId, companyName: company.name, provider: atsType ?? "unknown", startedAt, status: "unsupported", durationMs });
        return { companyId, name: company.name, status: "unsupported", newCount: 0, updatedCount: 0, jobsScanned: 0, engineeringInternshipsFound: 0, missingCount: 0, closedCount: 0, durationMs };
      }
    }
  }

  try {
    const { jobs, supported, notModified, etag, lastModified, contentHash } = await listJobsForCompany({
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
      : await ingestDiscoveredJobs(relevant, atsType, atsIdentifier);
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

    await prisma.company.update({
      where: { id: companyId },
      data: {
        atsType,
        atsIdentifier,
        lastCheckedAt: new Date(),
        nextCheckAt: nextCheckTimeFor(effectivePriority(company, atsType), 0, atsType),
        ...(notModified ? {} : { activeInternshipCount: relevant.length }),
        lastCheckStatus: supported ? "success" : "unsupported",
        lastCheckError: null,
        consecutiveFailures: 0,
        lastBoardQueryMs: durationMs,
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
      engineeringInternshipsFound: relevant.length,
      newJobs: summary.newCount,
      updatedJobs: summary.updatedCount,
      missingJobs: delta.missing,
      closedJobs: delta.closed,
      durationMs,
    });

    return {
      companyId,
      name: company.name,
      status: supported ? "success" : "unsupported",
      newCount: summary.newCount,
      updatedCount: summary.updatedCount,
      jobsScanned: jobs.length,
      engineeringInternshipsFound: relevant.length,
      missingCount: delta.missing,
      closedCount: delta.closed,
      durationMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const consecutiveFailures = company.consecutiveFailures + 1;
    await prisma.company.update({
      where: { id: companyId },
      data: {
        lastCheckedAt: new Date(),
        nextCheckAt: nextCheckTimeFor(effectivePriority(company, atsType), consecutiveFailures, atsType),
        lastCheckStatus: "error",
        lastCheckError: message,
        consecutiveFailures,
      },
    });
    const durationMs = Date.now() - startedAt.getTime();
    await recordOfficialPoll({ companyId, companyName: company.name, provider: atsType ?? "unknown", startedAt, status: "error", durationMs, errorCode: sanitizeErrorCode(err) });
    return { companyId, name: company.name, status: "error", newCount: 0, updatedCount: 0, jobsScanned: 0, engineeringInternshipsFound: 0, missingCount: 0, closedCount: 0, durationMs, error: message };
  }
}

async function recordOfficialPoll(args: {
  companyId: string;
  companyName: string;
  provider: string;
  startedAt: Date;
  status: "success" | "not_modified" | "unsupported" | "error";
  jobsScanned?: number;
  engineeringInternshipsFound?: number;
  newJobs?: number;
  updatedJobs?: number;
  missingJobs?: number;
  closedJobs?: number;
  durationMs: number;
  errorCode?: string;
}): Promise<void> {
  await prisma.officialBoardPoll.create({
    data: {
      ...args,
      finishedAt: new Date(),
      jobsScanned: args.jobsScanned ?? 0,
      engineeringInternshipsFound: args.engineeringInternshipsFound ?? 0,
      newJobs: args.newJobs ?? 0,
      updatedJobs: args.updatedJobs ?? 0,
      missingJobs: args.missingJobs ?? 0,
      closedJobs: args.closedJobs ?? 0,
      errorCode: args.errorCode ?? null,
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
      nextCheckAt: true,
      lastCheckedAt: true,
    },
  });
  const tierRank = { A: 0, B: 1, C: 2 } as const;
  const time = (value: Date | null) => value?.getTime() ?? 0;
  const due = candidates
    .sort((left, right) => {
      const leftTier = pollingTierFor({ priority: left.priority, provider: left.atsType, eeCpeFit: left.csvEeCpeFit });
      const rightTier = pollingTierFor({ priority: right.priority, provider: right.atsType, eeCpeFit: right.csvEeCpeFit });
      return tierRank[leftTier] - tierRank[rightTier]
        || time(left.nextCheckAt) - time(right.nextCheckAt)
        || time(left.lastCheckedAt) - time(right.lastCheckedAt);
    })
    .slice(0, limit);

  const results: CompanyCheckResult[] = [];
  for (const company of due) {
    await waitForDomainSlot(domainForRateLimit(company));
    results.push(await checkCompany(company.id));
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
        return checkCompany(company.id);
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
    const summary = await ingestDiscoveredJobs(relevant, "usajobs", "usajobs");
    newCount += summary.newCount;
    updatedCount += summary.updatedCount;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { configured: true, newCount, updatedCount };
}
