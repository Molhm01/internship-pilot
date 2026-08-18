import { prisma } from "@/lib/db";
import { listJobsForCompany, type CompanyForListing } from "@/lib/ats";
import type { AtsJob } from "@/lib/ats/types";
import {
  isAggregatorUrl,
  isValidOfficialApplicationUrl,
} from "@/lib/applications/officialDestination";
import { promoteCanonicalDirectJob } from "@/lib/jobs/activeFeed";
import { inferResolvedSource } from "@/lib/sync/discoveryResolution";
import {
  extractNextData,
  parseInternListPayload,
  type RawInternListJob,
} from "@/lib/sync/internListAdapter";
import { isTargetEngineeringRole } from "@/lib/sync/classify";
import { scoreOfficialBoardMatch } from "@/lib/sync/officialBoardMatch";
import { probeOfficialJobAvailability } from "@/lib/sync/freshness";
import { upsertClassifiedAtsJob } from "@/lib/sync/ingest";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Jobright's public internship hub currently exposes these technical categories.
// The known engineering_development slug is kept first; alternate ML aliases are
// harmless because an invalid/public-empty category simply contributes zero rows.
const CATEGORY_SLUGS = [
  "engineering_development",
  "software_engineering",
  "machine_learning_ai",
  "machine_learning_and_ai",
  "data_engineer",
  "data_analyst",
] as const;

const FRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * ONE_DAY_MS;

function categoryUrl(slug: string): string {
  return `https://jobright.ai/minisites-jobs/intern/us/${slug}?embed=true`;
}

function companyKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|company|co|holdings|group)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function findCompanyConfig(
  companyName: string,
  companies: CompanyForListing[],
  exactMap: Map<string, CompanyForListing>,
): CompanyForListing | null {
  const key = companyKey(companyName);
  const exact = exactMap.get(key);
  if (exact) return exact;
  if (key.length < 5) return null;
  return (
    companies.find((company) => {
      const candidate = companyKey(company.name);
      return candidate.length >= 5 && (candidate.includes(key) || key.includes(candidate));
    }) ?? null
  );
}

function signalIdentity(job: RawInternListJob): string {
  return `${job.company}|${job.title}|${job.location ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

async function fetchCategory(slug: string, capturedAt: Date): Promise<RawInternListJob[]> {
  try {
    const response = await fetch(categoryUrl(slug), {
      headers: { "User-Agent": USER_AGENT },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return [];
    const nextData = extractNextData(await response.text());
    return nextData ? parseInternListPayload(nextData, capturedAt) : [];
  } catch {
    return [];
  }
}

export async function fetchJobrightFreshSignals(now = new Date()): Promise<{
  jobs: RawInternListJob[];
  categoryCounts: Record<string, number>;
  freshUnder24h: number;
  freshUnder72h: number;
}> {
  const batches = await Promise.all(
    CATEGORY_SLUGS.map(async (slug) => ({ slug, jobs: await fetchCategory(slug, now) })),
  );

  const categoryCounts: Record<string, number> = {};
  const seen = new Set<string>();
  const jobs: RawInternListJob[] = [];
  for (const batch of batches) {
    categoryCounts[batch.slug] = batch.jobs.length;
    for (const job of batch.jobs) {
      if (!job.sourcePostedAt) continue;
      const ageMs = now.getTime() - job.sourcePostedAt.getTime();
      if (ageMs < 0 || ageMs > FRESH_MAX_AGE_MS) continue;
      if (!isTargetEngineeringRole(job.title, job.qualifications)) continue;
      const key = signalIdentity(job);
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(job);
    }
  }

  jobs.sort(
    (a, b) =>
      (b.sourcePostedAt?.getTime() ?? 0) - (a.sourcePostedAt?.getTime() ?? 0) ||
      a.sourceRowIndex - b.sourceRowIndex,
  );

  return {
    jobs,
    categoryCounts,
    freshUnder24h: jobs.filter((job) => now.getTime() - job.sourcePostedAt!.getTime() <= ONE_DAY_MS).length,
    freshUnder72h: jobs.filter((job) => now.getTime() - job.sourcePostedAt!.getTime() <= THREE_DAYS_MS).length,
  };
}

function asAtsJob(signal: RawInternListJob, applyUrl: string, boardJob?: AtsJob | null): AtsJob {
  return {
    sourceJobId: boardJob?.sourceJobId ?? `jobright-fresh:${signal.sourceJobId}`,
    requisitionId: boardJob?.requisitionId ?? null,
    title: boardJob?.title ?? signal.title,
    company: signal.company,
    location: boardJob?.location ?? signal.location,
    workplaceType: boardJob?.workplaceType ?? signal.workModel,
    applyUrl,
    description: boardJob?.description || signal.qualifications || "",
    postedAt: boardJob?.postedAt ?? signal.sourcePostedAt,
    postedAtText: boardJob?.postedAtText ?? signal.sourcePostedText,
  };
}

async function persistOfficialSignal(signal: RawInternListJob, job: AtsJob): Promise<"new" | "updated" | "unchanged"> {
  const resolved = inferResolvedSource(job.applyUrl);
  const outcome = await upsertClassifiedAtsJob({
    job,
    source: resolved.source,
    atsType: resolved.atsType,
    atsTenant: resolved.atsTenant,
    classification: "QUALIFYING_INTERNSHIP",
    classificationReason:
      "Fresh public internship signal independently resolved to an original employer/ATS posting.",
    now: new Date(),
  });
  await promoteCanonicalDirectJob(job, resolved.source, resolved.atsTenant);
  return outcome;
}

function bestBoardMatch(signal: RawInternListJob, jobs: AtsJob[]): AtsJob | null {
  let best: { job: AtsJob; score: number } | null = null;
  for (const job of jobs) {
    const score = scoreOfficialBoardMatch(
      { title: signal.title, location: signal.location },
      job,
    );
    if (!best || score > best.score) best = { job, score };
  }
  return best && best.score >= 0.72 ? best.job : null;
}

export async function runJobrightFreshDiscovery(limit = 150): Promise<{
  categoriesAttempted: number;
  categoryCounts: Record<string, number>;
  sourceFresh: number;
  freshUnder24h: number;
  freshUnder72h: number;
  examined: number;
  directResolved: number;
  boardResolved: number;
  unresolved: number;
  closed: number;
  newCount: number;
  updatedCount: number;
}> {
  const boundedLimit = Math.max(1, Math.min(limit, 200));
  const now = new Date();
  const source = await fetchJobrightFreshSignals(now);
  const selected = source.jobs.slice(0, boundedLimit);

  const companies: CompanyForListing[] = await prisma.company.findMany({
    where: { allowlisted: true, monitoringStatus: "active" },
    select: {
      name: true,
      atsType: true,
      atsIdentifier: true,
      careersUrl: true,
      lastETag: true,
      lastModified: true,
      contentHash: true,
    },
  });
  const exactMap = new Map(companies.map((company) => [companyKey(company.name), company]));

  let directResolved = 0;
  let boardResolved = 0;
  let unresolved = 0;
  let closed = 0;
  let newCount = 0;
  let updatedCount = 0;

  const withoutDirect: RawInternListJob[] = [];
  let cursor = 0;
  const directWorkers = Array.from({ length: Math.min(16, selected.length) }, async () => {
    while (cursor < selected.length) {
      const signal = selected[cursor++]!;
      const direct = [signal.officialApplicationUrl, signal.originalJobPostUrl, signal.applyUrl]
        .find((value): value is string => Boolean(value) && !isAggregatorUrl(value) && isValidOfficialApplicationUrl(value));
      if (!direct) {
        withoutDirect.push(signal);
        continue;
      }

      const probe = await probeOfficialJobAvailability(direct);
      if (probe.state === "closed") {
        closed += 1;
        continue;
      }

      try {
        const outcome = await persistOfficialSignal(signal, asAtsJob(signal, direct));
        directResolved += 1;
        if (outcome === "new") newCount += 1;
        else if (outcome === "updated") updatedCount += 1;
      } catch {
        unresolved += 1;
      }
    }
  });
  await Promise.all(directWorkers);

  const grouped = new Map<string, { config: CompanyForListing; signals: RawInternListJob[] }>();
  for (const signal of withoutDirect) {
    const config = findCompanyConfig(signal.company, companies, exactMap);
    if (!config) {
      unresolved += 1;
      continue;
    }
    const key = config.name;
    const group = grouped.get(key) ?? { config, signals: [] };
    group.signals.push(signal);
    grouped.set(key, group);
  }

  const groups = [...grouped.values()];
  let groupCursor = 0;
  const boardWorkers = Array.from({ length: Math.min(8, groups.length) }, async () => {
    while (groupCursor < groups.length) {
      const group = groups[groupCursor++]!;
      let boardJobs: AtsJob[] = [];
      try {
        const result = await listJobsForCompany({
          ...group.config,
          lastETag: null,
          lastModified: null,
          contentHash: null,
        });
        if (result.supported) boardJobs = result.jobs;
      } catch {
        boardJobs = [];
      }

      for (const signal of group.signals) {
        const match = bestBoardMatch(signal, boardJobs);
        if (!match?.applyUrl || isAggregatorUrl(match.applyUrl)) {
          unresolved += 1;
          continue;
        }
        try {
          const outcome = await persistOfficialSignal(signal, asAtsJob(signal, match.applyUrl, match));
          boardResolved += 1;
          if (outcome === "new") newCount += 1;
          else if (outcome === "updated") updatedCount += 1;
        } catch {
          unresolved += 1;
        }
      }
    }
  });
  await Promise.all(boardWorkers);

  return {
    categoriesAttempted: CATEGORY_SLUGS.length,
    categoryCounts: source.categoryCounts,
    sourceFresh: source.jobs.length,
    freshUnder24h: source.freshUnder24h,
    freshUnder72h: source.freshUnder72h,
    examined: selected.length,
    directResolved,
    boardResolved,
    unresolved,
    closed,
    newCount,
    updatedCount,
  };
}
