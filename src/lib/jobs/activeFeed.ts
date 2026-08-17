import { prisma } from "@/lib/db";
import type { AtsJob } from "@/lib/ats/types";
import { canonicalizeJobUrl } from "@/lib/sync/ingest";
import {
  canonicalizeSource,
  computeActiveFeed,
  isLegacyAutoPromotableDirectSource,
  isTrustedAggregatorSource,
} from "@/lib/jobs/sourcePolicy";

function verificationMethodFor(source: string): string {
  return source === "icims" || source === "successfactors"
    ? `${source}-public-job-page`
    : `${source}-board-api`;
}

/** Recompute and persist the Active-feed flag for one job. */
export async function recomputeJobActiveFeed(jobId: string): Promise<boolean> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { source: true, verificationStatus: true, company: true, activeFeed: true },
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
      activeFeed: true,
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
    },
  });

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

  const directGroups = new Map<string, { ids: string[]; inactive: number }>();
  for (const job of jobs) {
    if (!isLegacyAutoPromotableDirectSource(job.source)) continue;
    if (!job.officialApplicationUrl && !job.sourceUrl) continue;
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
  const now = new Date();
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
    promotedDirect,
    visibilityUpdated: hiddenAggregators + directVisibilityUpdates,
  };
}

/** Idempotent full visibility backfill. */
export async function backfillActiveFeed(): Promise<{ scanned: number; updated: number }> {
  const jobs = await prisma.job.findMany({
    select: { id: true, source: true, verificationStatus: true, company: true, activeFeed: true },
  });
  let updated = 0;
  for (const job of jobs) {
    const next = computeActiveFeed(job);
    if (next !== job.activeFeed) {
      await prisma.job.update({ where: { id: job.id }, data: { activeFeed: next } });
      updated += 1;
    }
  }
  return { scanned: jobs.length, updated };
}
