import { prisma } from "@/lib/db";
import {
  canonicalizeSource,
  computeActiveFeed,
  isDirectOfficialSource,
  isTrustedAggregatorSource,
} from "@/lib/jobs/sourcePolicy";

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
 * Idempotent production cutover/repair.
 *
 * This is intentionally batched: the first production run may need to flip
 * hundreds of legacy aggregator rows, and a serverless function should do a
 * handful of updateMany calls rather than hundreds of sequential updates.
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
    if (!isDirectOfficialSource(job.source)) continue;
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
        verificationMethod: `${source}-board-api`,
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
