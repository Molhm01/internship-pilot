import { prisma } from "@/lib/db";
import type { AtsJob } from "@/lib/ats/types";
import { canonicalizeJobUrl } from "@/lib/sync/ingest";
import {
  canonicalizeSource,
  computeActiveFeed,
  isLegacyAutoPromotableDirectSource,
  isTrustedAggregatorSource,
  isWithinActiveFreshnessWindow,
  MAX_ACTIVE_FEED_AGE_DAYS,
} from "@/lib/jobs/sourcePolicy";

function verificationMethodFor(source: string): string {
  return source === "icims" || source === "successfactors"
    ? `${source}-public-job-page`
    : `${source}-board-api`;
}

/** Deactivate any non-manual active feed jobs older than the active freshness window. */
export async function pruneStaleActiveJobs(
  maxAgeDays = MAX_ACTIVE_FEED_AGE_DAYS,
  now = new Date(),
): Promise<{ checked: number; pruned: number }> {
  const activeJobs = await prisma.job.findMany({
    where: { activeFeed: true },
    select: {
      id: true,
      source: true,
      sourcePostedAt: true,
      createdAt: true,
    },
  });

  const staleIds = activeJobs
    .filter((job) => !isWithinActiveFreshnessWindow(job, maxAgeDays, now))
    .map((job) => job.id);

  if (staleIds.length === 0) {
    return { checked: activeJobs.length, pruned: 0 };
  }

  const res = await prisma.job.updateMany({
    where: { id: { in: staleIds } },
    data: { activeFeed: false },
  });

  return { checked: activeJobs.length, pruned: res.count };
}

/** Recompute and persist the Active-feed flag for one job. */
export async function recomputeJobActiveFeed(jobId: string): Promise<boolean> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      source: true,
      verificationStatus: true,
      company: true,
      activeFeed: true,
      sourcePostedAt: true,
      createdAt: true,
    },
  });
  if (!job) return false;
  const next = computeActiveFeed(job);
  if (next !== job.activeFeed) {
    await prisma.job.update({ where: { id: jobId }, data: { activeFeed: next } });
  }
  return next;
}

/**
 * If a direct ATS sighting matched a legacy aggregator/generic row by URL,
 * promote that exact row so the canonical provenance and click target are the
 * verified employer/public-authority source.
 */
export async function promoteCanonicalDirectJob(
  job: AtsJob,
  atsType: string,
  atsIdentifier: string,
): Promise<void> {
  const canonical = canonicalizeJobUrl(job.applyUrl);
  if (!canonical) return;

  const candidates = await prisma.job.findMany({
    where: { company: { equals: job.company } },
    select: {
      id: true,
      sourceUrl: true,
      officialApplicationUrl: true,
      officialApplyUrl: true,
      officialJobUrl: true,
      url: true,
      sourcePostedAt: true,
      createdAt: true,
    },
  });

  const match = candidates.find((candidate) =>
    [
      candidate.officialApplicationUrl,
      candidate.officialApplyUrl,
      candidate.officialJobUrl,
      candidate.sourceUrl,
      candidate.url,
    ]
      .map(canonicalizeJobUrl)
      .some((value) => value !== null && value === canonical),
  );
  if (!match) return;

  const now = new Date();
  const effectivePostedAt = job.postedAt ?? match.sourcePostedAt;
  const activeFeed = computeActiveFeed({
    source: atsType,
    verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
    company: job.company,
    sourcePostedAt: effectivePostedAt,
    createdAt: match.createdAt,
    now,
  });

  await prisma.job.update({
    where: { id: match.id },
    data: {
      source: atsType,
      sourceJobId: job.sourceJobId,
      requisitionId: job.requisitionId ?? undefined,
      sourceUrl: job.applyUrl,
      sourceListingUrl: null,
      officialApplicationUrl: job.applyUrl,
      originalJobPostUrl: job.applyUrl,
      verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
      reasonCode: "OFFICIAL_ATS_BOARD",
      verificationReason: `Read directly from the official ${atsType} job source.`,
      verificationMethod: verificationMethodFor(atsType),
      lastVerifiedAt: now,
      atsType,
      atsTenant: atsIdentifier,
      classification: "QUALIFYING_INTERNSHIP",
      classificationReason:
        "Read from an official source and matched the engineering internship/co-op role filter.",
      activeFeed,
    },
  });
}

/**
 * Idempotent production cutover/repair.
 *
 * Only sources that historically ALWAYS used a trusted direct adapter are
 * eligible for bulk promotion. iCIMS/SuccessFactors had legacy generic scans,
 * so their old rows stay hidden until promoteCanonicalDirectJob() verifies the
 * exact job URL through the new structured adapters.
 */
export async function reconcileDirectOfficialFeed(): Promise<{
  scanned: number;
  hiddenAggregators: number;
  prunedStale: number;
  promotedDirect: number;
  visibilityUpdated: number;
}> {
  const jobs = await prisma.job.findMany({
    select: {
      id: true,
      source: true,
      verificationStatus: true,
      company: true,
      activeFeed: true,
      officialApplicationUrl: true,
      sourceUrl: true,
      sourcePostedAt: true,
      createdAt: true,
    },
  });

  const now = new Date();

  const aggregatorIds = jobs
    .filter((job) => isTrustedAggregatorSource(job.source) && job.activeFeed)
    .map((job) => job.id);

  let hiddenAggregators = 0;
  if (aggregatorIds.length > 0) {
    const result = await prisma.job.updateMany({
      where: { id: { in: aggregatorIds } },
      data: { activeFeed: false },
    });
    hiddenAggregators = result.count;
  }

  const staleIds = jobs
    .filter((job) => job.activeFeed && !isWithinActiveFreshnessWindow(job, MAX_ACTIVE_FEED_AGE_DAYS, now))
    .map((job) => job.id);

  let prunedStale = 0;
  if (staleIds.length > 0) {
    const staleResult = await prisma.job.updateMany({
      where: { id: { in: staleIds } },
      data: { activeFeed: false },
    });
    prunedStale = staleResult.count;
  }

  const directGroups = new Map<string, { ids: string[]; inactive: number }>();
  for (const job of jobs) {
    if (!isLegacyAutoPromotableDirectSource(job.source)) continue;
    if (!job.officialApplicationUrl && !job.sourceUrl) continue;
    if (!isWithinActiveFreshnessWindow(job, MAX_ACTIVE_FEED_AGE_DAYS, now)) continue;
    const canonical = canonicalizeSource(job.source);
    if (!canonical) continue;
    if (job.verificationStatus === "VERIFIED_OFFICIAL_AT_LAST_CHECK" && job.activeFeed) continue;
    const group = directGroups.get(canonical) ?? { ids: [], inactive: 0 };
    group.ids.push(job.id);
    if (!job.activeFeed) group.inactive += 1;
    directGroups.set(canonical, group);
  }

  let promotedDirect = 0;
  let directVisibilityUpdates = 0;
  for (const [source, group] of directGroups) {
    const result = await prisma.job.updateMany({
      where: { id: { in: group.ids } },
      data: {
        verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
        reasonCode: "OFFICIAL_ATS_BOARD",
        verificationReason: `Read directly from the official ${source} job source.`,
        verificationMethod: verificationMethodFor(source),
        lastVerifiedAt: now,
        activeFeed: true,
      },
    });
    promotedDirect += result.count;
    directVisibilityUpdates += group.inactive;
  }

  return {
    scanned: jobs.length,
    hiddenAggregators,
    prunedStale,
    promotedDirect,
    visibilityUpdated: hiddenAggregators + prunedStale + directVisibilityUpdates,
  };
}

/** Idempotent full visibility backfill. */
export async function backfillActiveFeed(): Promise<{ scanned: number; updated: number }> {
  const jobs = await prisma.job.findMany({
    select: {
      id: true,
      source: true,
      verificationStatus: true,
      company: true,
      activeFeed: true,
      sourcePostedAt: true,
      createdAt: true,
    },
  });
  const now = new Date();
  let updated = 0;
  for (const job of jobs) {
    const next = computeActiveFeed({ ...job, now });
    if (next !== job.activeFeed) {
      await prisma.job.update({ where: { id: job.id }, data: { activeFeed: next } });
      updated += 1;
    }
  }
  return { scanned: jobs.length, updated };
}
