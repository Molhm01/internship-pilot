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

export type CompanyCheckResult = {
  companyId: string;
  name: string;
  status: "success" | "error" | "unsupported";
  newCount: number;
  updatedCount: number;
  error?: string;
};

export type CompanySweepResult = {
  checked: number;
  totalEligible: number;
  stoppedForTimeBudget: boolean;
  results: CompanyCheckResult[];
};

const MAX_BACKOFF_MINUTES = 24 * 60;

function baseIntervalMinutes(priority: string): number {
  if (priority === "priority") return 5;
  if (priority === "low") return 24 * 60;
  return 15 + Math.floor(Math.random() * 15);
}

export function nextCheckTimeFor(priority: string, consecutiveFailures: number): Date {
  const base = baseIntervalMinutes(priority);
  const minutes = consecutiveFailures > 0 ? Math.min(MAX_BACKOFF_MINUTES, base * 2 ** consecutiveFailures) : base;
  return new Date(Date.now() + minutes * 60 * 1000);
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
          data: { lastCheckedAt: new Date(), nextCheckAt: nextCheckTimeFor(company.priority, 0), lastCheckStatus: "unsupported" },
        });
        return { companyId, name: company.name, status: "unsupported", newCount: 0, updatedCount: 0 };
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

    await prisma.company.update({
      where: { id: companyId },
      data: {
        atsType,
        atsIdentifier,
        lastCheckedAt: new Date(),
        nextCheckAt: nextCheckTimeFor(company.priority, 0),
        ...(notModified ? {} : { activeInternshipCount: relevant.length }),
        lastCheckStatus: supported ? "success" : "unsupported",
        lastCheckError: null,
        consecutiveFailures: 0,
        ...(etag !== undefined ? { lastETag: etag } : {}),
        ...(lastModified !== undefined ? { lastModified } : {}),
        ...(contentHash !== undefined ? { contentHash } : {}),
      },
    });

    return {
      companyId,
      name: company.name,
      status: supported ? "success" : "unsupported",
      newCount: summary.newCount,
      updatedCount: summary.updatedCount,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const consecutiveFailures = company.consecutiveFailures + 1;
    await prisma.company.update({
      where: { id: companyId },
      data: {
        lastCheckedAt: new Date(),
        nextCheckAt: nextCheckTimeFor(company.priority, consecutiveFailures),
        lastCheckStatus: "error",
        lastCheckError: message,
        consecutiveFailures,
      },
    });
    return { companyId, name: company.name, status: "error", newCount: 0, updatedCount: 0, error: message };
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

export async function runCompanyDiscoveryBatch(limit = 5): Promise<{ checked: number; results: CompanyCheckResult[] }> {
  const due: { id: string; atsType: string | null; careersUrl: string | null }[] = [];
  for (const priority of ["priority", "standard", "low"]) {
    if (due.length >= limit) break;
    const companies = await prisma.company.findMany({
      where: {
        priority,
        monitoringStatus: "active",
        allowlisted: true,
        OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }],
      },
      orderBy: [
        { nextCheckAt: { sort: "asc", nulls: "first" } },
        { lastCheckedAt: { sort: "asc", nulls: "first" } },
      ],
      take: limit - due.length,
      select: { id: true, atsType: true, careersUrl: true },
    });
    due.push(...companies);
  }

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
