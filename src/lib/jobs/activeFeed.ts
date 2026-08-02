import { prisma } from "@/lib/db";
import { computeActiveFeed } from "@/lib/jobs/sourcePolicy";

/**
 * Recompute and persist the Active-feed VISIBILITY flag for one job using the
 * central policy. Call this from every path that creates a job or changes its
 * source/company/verificationStatus, so the flag can never drift.
 * Returns the resulting boolean. Never touches verificationStatus.
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
 * Idempotent full backfill/repair. Applies the exact policy to every job and
 * only writes rows whose flag is wrong. Safe to run any number of times.
 */
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
