import { prisma } from "@/lib/db";
import { listJobsForCompany } from "@/lib/ats";
import { detectAtsForCareersPage } from "@/lib/ats/detect";
import { getUsaJobsConfig, searchUsaJobs } from "@/lib/ats/usajobs";
import { ingestAtsJobs } from "@/lib/sync/ingest";
import { isTargetEngineeringRole } from "@/lib/sync/classify";
import { logAudit } from "@/lib/applications/audit";

export type CompanyCheckResult = {
  companyId: string;
  name: string;
  status: "success" | "error" | "unsupported";
  newCount: number;
  updatedCount: number;
  error?: string;
};

const MAX_BACKOFF_MINUTES = 24 * 60;

// Priority: every 5 min. Standard: staggered 15-30 min (randomized each time,
// so a batch of standard companies doesn't all line up on the same tick).
// Low (includes nearby-discovered firms): once a day.
function baseIntervalMinutes(priority: string): number {
  if (priority === "priority") return 5;
  if (priority === "low") return 24 * 60;
  return 15 + Math.floor(Math.random() * 15); // standard: 15-30
}

// Failed-source retry uses exponential backoff on top of the base interval,
// capped at 24h, and resets the moment a check succeeds (or is merely
// "unsupported", which isn't a transient failure).
export function nextCheckTimeFor(priority: string, consecutiveFailures: number): Date {
  const base = baseIntervalMinutes(priority);
  const minutes = consecutiveFailures > 0 ? Math.min(MAX_BACKOFF_MINUTES, base * 2 ** consecutiveFailures) : base;
  return new Date(Date.now() + minutes * 60 * 1000);
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

  // Never trust an ATS-hosted job just because a Company row happens to
  // have an atsType/atsIdentifier set (e.g. hand-entered in seed data) —
  // require (and persist) actual evidence that THIS employer's OWN careers
  // page links to THIS specific tenant before any job from it is ingested.
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

    // Conditional-request hit: the careers page hasn't changed since we last
    // checked it, so there's nothing new to ingest this cycle.
    const relevant = notModified ? [] : jobs.filter((j) => isTargetEngineeringRole(j.title, j.description));
    const summary = notModified
      ? { newCount: 0, updatedCount: 0 }
      : await ingestAtsJobs(relevant, atsType ? `ats:${atsType}` : "unknown");

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
        ...(lastModified !== undefined ? { lastModified: lastModified } : {}),
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

// ATS API calls all go to a small number of FIXED shared hosts regardless of
// which employer's board it is (every Greenhouse-hosted company's requests
// land on the same boards-api.greenhouse.io, for instance) — rate limiting
// per employer alone wouldn't actually protect that shared host once there
// are hundreds of CSV-listed companies on the same ATS. Rate limiting is
// tracked per ACTUAL destination domain instead.
const ATS_API_DOMAINS: Record<string, string> = {
  greenhouse: "boards-api.greenhouse.io",
  lever: "api.lever.co",
  ashby: "api.ashbyhq.com",
  smartrecruiters: "api.smartrecruiters.com",
  workday: "myworkdayjobs.com", // per-tenant subdomains, grouped together for rate-limiting purposes
};
const MIN_MS_BETWEEN_SAME_DOMAIN_REQUESTS = 1500;
const lastHitAtByDomain = new Map<string, number>();

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

async function waitForDomainSlot(domain: string): Promise<void> {
  const lastHit = lastHitAtByDomain.get(domain);
  if (lastHit !== undefined) {
    const elapsed = Date.now() - lastHit;
    if (elapsed < MIN_MS_BETWEEN_SAME_DOMAIN_REQUESTS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_MS_BETWEEN_SAME_DOMAIN_REQUESTS - elapsed));
    }
  }
  lastHitAtByDomain.set(domain, Date.now());
}

// Priority companies first, then standard, then low — a due company (never
// checked, or nextCheckAt in the past) from each tier in turn until `limit`.
// Requests are made strictly one at a time (never concurrently), with both a
// short global pause AND a per-destination-domain minimum interval — a
// rate-limited queue, not hundreds of simultaneous requests, and safe to run
// against a CSV allowlist of hundreds of employers sharing a handful of
// actual ATS hosts.
export async function runCompanyDiscoveryBatch(limit = 5): Promise<{ checked: number; results: CompanyCheckResult[] }> {
  const due: { id: string; atsType: string | null; careersUrl: string | null }[] = [];
  for (const priority of ["priority", "standard", "low"]) {
    if (due.length >= limit) break;
    const companies = await prisma.company.findMany({
      where: {
        priority,
        monitoringStatus: "active",
        // Strict discovery boundary: only ever actively check employers
        // sourced from the CSV allowlist, manual entries, or Intern-List
        // employers the user has explicitly approved.
        allowlisted: true,
        OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }],
      },
      orderBy: { nextCheckAt: "asc" },
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
    const summary = await ingestAtsJobs(relevant, "usajobs");
    newCount += summary.newCount;
    updatedCount += summary.updatedCount;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { configured: true, newCount, updatedCount };
}
