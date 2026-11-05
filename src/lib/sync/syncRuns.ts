import { prisma } from "@/lib/db";

/**
 * Every syncLog row with status "running" is a claim that a function is still
 * working. On serverless, a function that is killed - platform timeout, lost
 * database connection, instance recycle - never runs its catch block, so the
 * claim outlives the work forever.
 *
 * Recovery is scoped to sources produced EXCLUSIVELY by Vercel cron routes,
 * which all cap at maxDuration 300s, so fifteen minutes is a provable 3x
 * margin and can never touch legitimate active work. "intern-list" is
 * deliberately excluded: the local in-process scheduler
 * (src/lib/sync/scheduler.ts) also produces those rows outside any function
 * time cap. Closing a row is bookkeeping only - it cannot cancel the
 * underlying work, and if a producer were somehow still alive it would simply
 * overwrite the row's status when it finishes.
 */
export const STALE_RUNNING_MS = 15 * 60 * 1000;

export const RECOVERABLE_SOURCES = ["employer-ats", "live-discovery", "gmail-radar-hosted"] as const;

export async function recoverStaleSyncRuns(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUNNING_MS);
  const result = await prisma.syncLog.updateMany({
    where: {
      status: "running",
      startedAt: { lt: cutoff },
      OR: [{ source: { in: [...RECOVERABLE_SOURCES] } }, { source: { startsWith: "cron:" } }],
    },
    data: {
      status: "error",
      finishedAt: now,
      errorMessage:
        "stale:recovered - exceeded 15m without completing; the function died or lost its database connection",
    },
  });
  return result.count;
}
