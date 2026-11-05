import { prisma } from "@/lib/db";

/**
 * Every syncLog row with status "running" is a claim that a function is still
 * working. On serverless, a function that is killed - platform timeout, lost
 * database connection, instance recycle - never runs its catch block, so the
 * claim outlives the work forever. Fifteen minutes comfortably exceeds every
 * legitimate run (all cron routes cap at maxDuration 300s), so anything older
 * is recovered as an error with the reason preserved, never deleted.
 */
export const STALE_RUNNING_MS = 15 * 60 * 1000;

export async function recoverStaleSyncRuns(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUNNING_MS);
  const result = await prisma.syncLog.updateMany({
    where: { status: "running", startedAt: { lt: cutoff } },
    data: {
      status: "error",
      finishedAt: now,
      errorMessage:
        "stale:recovered - exceeded 15m without completing; the function died or lost its database connection",
    },
  });
  return result.count;
}
