import { prisma } from "@/lib/db";
import {
  canonicalizeSource,
  computeActiveFeed,
  isDirectOfficialSource,
  isTrustedAggregatorSource,
} from "@/lib/jobs/sourcePolicy";

/**
 * Recompute and persist the Active-feed VISIBILITY flag for one job using the
 * central policy. Returns the resulting boolean. Never touches verificationStatus.
 */
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
 * One idempotent catalogue cutover/repair.
 *
 * - hides Jobright/Simplify/Intern-List rows from the default Discover feed;
 * - upgrades rows already read directly from an official ATS but accidentally
 *   stored as Pending by the old company-discovery path;
 * - recomputes activeFeed from the new direct-source policy.
 *
 * Safe to run on every hosted cron invocation. It never deletes jobs.
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
      lastVerifiedAt: true,
    },
  });

  let hiddenAggregators = 0;
  let promotedDirect = 0;
  let visibilityUpdated = 0;
  const now = new Date();

  for (const job of jobs) {
    const canonical = canonicalizeSource(job.source);
    const aggregator = isTrustedAggregatorSource(job.source);
    const direct = isDirectOfficialSource(job.source) && Boolean(job.officialApplicationUrl ?? job.sourceUrl);

    let verificationStatus = job.verificationStatus;
    const data: Record<string, unknown> = {};

    if (direct && verificationStatus !== "VERIFIED_OFFICIAL_AT_LAST_CHECK") {
      verificationStatus = "VERIFIED_OFFICIAL_AT_LAST_CHECK";
      data.verificationStatus = verificationStatus;
      data.reasonCode = "OFFICIAL_ATS_BOARD";
      data.verificationReason = `Read directly from the official ${canonical ?? "ATS"} job source.`;
      data.verificationMethod = `${canonical ?? "ats"}-board-api`;
      data.lastVerifiedAt = job.lastVerifiedAt ?? now;
      promotedDirect += 1;
    }

    const nextActive = computeActiveFeed({
      source: job.source,
      verificationStatus,
      company: job.company,
    });

    if (aggregator && job.activeFeed && !nextActive) hiddenAggregators += 1;
    if (nextActive !== job.activeFeed) {
      data.activeFeed = nextActive;
      visibilityUpdated += 1;
    }

    if (Object.keys(data).length > 0) {
      await prisma.job.update({ where: { id: job.id }, data });
    }
  }

  return { scanned: jobs.length, hiddenAggregators, promotedDirect, visibilityUpdated };
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
