import { prisma } from "@/lib/db";
import { runMatchForJob } from "@/lib/matching";

/**
 * The legacy `Job.scoringState` queue.
 *
 * Superseded in the product by `initialAiMatchQueue`, which is what discovery
 * and the Jobs page use; this module survives for the local scoring-queue test
 * harnesses. It still needs an owner, because the thing it ultimately calls —
 * `runMatchForJob` — writes a score that belongs to somebody. There is no
 * default and no "first user" fallback: a queue that guesses whose score it is
 * producing is exactly the defect this conversion removes.
 */
export type QueueMatchOptions = {
  /** Whose scores these are. Required. */
  userId: string;
  jobId?: string;
  allUnscored?: boolean;
  rescoreStale?: boolean;
};

export type QueueMatchResult = {
  requested: number;
  eligible: number;
  alreadyQueued: number;
  newlyQueued: number;
  skipped: number;
  reasons: string[];
};

let scoringWorkerTimer: NodeJS.Timeout | null = null;
let lastHeartbeat: Date | null = null;
let currentlyScoringJobId: string | null = null;

// The scorer is injectable so a deterministic test can drive the queue without
// a live Ollama server. Production always uses runMatchForJob.
type Scorer = (jobId: string, options: { userId: string }) => Promise<unknown>;
let scorer: Scorer = runMatchForJob;
export function __setScorerForTests(fn: Scorer | null) {
  scorer = fn ?? runMatchForJob;
}

// Stop the in-process drain timer (tests only) so a test can drive the queue
// single-threaded without the shared background worker also draining.
export function __stopScoringWorkerForTests() {
  if (scoringWorkerTimer) { clearTimeout(scoringWorkerTimer); scoringWorkerTimer = null; }
}

export function getScoringWorkerStatus() {
  return {
    lastHeartbeat,
    currentlyScoringJobId,
    activeTimer: Boolean(scoringWorkerTimer),
  };
}

export async function queueJobsForMatching(options: QueueMatchOptions): Promise<QueueMatchResult> {
  const { jobId, allUnscored, rescoreStale } = options;

  if (jobId) {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      return { requested: 1, eligible: 0, alreadyQueued: 0, newlyQueued: 0, skipped: 1, reasons: ["Job not found"] };
    }
    const alreadyQueued = job.scoringState === "QUEUED" || job.scoringState === "SCORING";
    await prisma.job.update({
      where: { id: jobId },
      data: {
        scoringState: "QUEUED",
        scoringPriority: 10, // Top priority for manual "Run AI Match Now"
        scoringQueuedAt: new Date(),
        scoringError: null,
      },
    });
    triggerScoringWorker(options.userId);
    return {
      requested: 1,
      eligible: 1,
      alreadyQueued: alreadyQueued ? 1 : 0,
      newlyQueued: alreadyQueued ? 0 : 1,
      skipped: 0,
      reasons: [],
    };
  }

  if (allUnscored) {
    const activeJobs = await prisma.job.findMany({
      where: { activeFeed: true },
      select: { id: true, matchScore: true, scoringState: true },
    });

    const eligibleJobs = activeJobs.filter((j) => j.matchScore === null || j.scoringState === "NOT_SCORED");
    const alreadyQueuedJobs = eligibleJobs.filter((j) => j.scoringState === "QUEUED" || j.scoringState === "SCORING");
    const toQueue = eligibleJobs.filter((j) => j.scoringState !== "QUEUED" && j.scoringState !== "SCORING");

    if (toQueue.length > 0) {
      await prisma.job.updateMany({
        where: { id: { in: toQueue.map((j) => j.id) } },
        data: {
          scoringState: "QUEUED",
          scoringPriority: 1,
          scoringQueuedAt: new Date(),
          scoringError: null,
        },
      });
    }

    triggerScoringWorker(options.userId);

    return {
      requested: activeJobs.length,
      eligible: eligibleJobs.length,
      alreadyQueued: alreadyQueuedJobs.length,
      newlyQueued: toQueue.length,
      skipped: activeJobs.length - eligibleJobs.length,
      reasons: eligibleJobs.length === 0 ? ["All active jobs are already scored."] : [],
    };
  }

  if (rescoreStale) {
    const activeJobs = await prisma.job.findMany({
      where: { activeFeed: true },
      select: { id: true, scoringState: true },
    });

    const toQueue = activeJobs.filter((j) => j.scoringState !== "QUEUED" && j.scoringState !== "SCORING");
    const alreadyQueued = activeJobs.length - toQueue.length;

    if (toQueue.length > 0) {
      await prisma.job.updateMany({
        where: { id: { in: toQueue.map((j) => j.id) } },
        data: {
          scoringState: "QUEUED",
          scoringPriority: 1,
          scoringQueuedAt: new Date(),
          scoringError: null,
        },
      });
    }

    triggerScoringWorker(options.userId);

    return {
      requested: activeJobs.length,
      eligible: activeJobs.length,
      alreadyQueued,
      newlyQueued: toQueue.length,
      skipped: 0,
      reasons: [],
    };
  }

  return { requested: 0, eligible: 0, alreadyQueued: 0, newlyQueued: 0, skipped: 0, reasons: ["No option provided"] };
}

export function triggerScoringWorker(userId: string) {
  if (scoringWorkerTimer) return;
  scoringWorkerTimer = setTimeout(() => {
    void processScoringQueue(userId);
  }, 100);
}

// Recover jobs orphaned by a process restart or a crashed worker:
//  - SCORING with a stale heartbeat (>30s) → back to QUEUED
// (QUEUED jobs need no state change; they just need the worker kicked, which
// the scheduler now does on a durable interval so a restart always re-drains.)
async function recoverAbandonedScoringJobs(): Promise<void> {
  const thirtySecsAgo = new Date(Date.now() - 30_000);
  await prisma.job.updateMany({
    where: { scoringState: "SCORING", scoringHeartbeatAt: { lt: thirtySecsAgo } },
    data: { scoringState: "QUEUED", scoringError: "Recovered from abandoned worker state" },
  });
}

// Claim and score exactly ONE queued job. Returns true if a job was processed
// (so a caller can loop until the queue drains). Deterministic and awaitable —
// used both by the timer chain and by tests.
export async function scoreNextQueuedJob(userId: string): Promise<boolean> {
  lastHeartbeat = new Date();
  await recoverAbandonedScoringJobs();

  const nextJob = await prisma.job.findFirst({
    where: { scoringState: "QUEUED" },
    orderBy: [{ scoringPriority: "desc" }, { scoringQueuedAt: "asc" }],
    select: { id: true, title: true, company: true },
  });
  if (!nextJob) {
    currentlyScoringJobId = null;
    return false;
  }

  const claimed = await prisma.job.updateMany({
    where: { id: nextJob.id, scoringState: "QUEUED" },
    data: { scoringState: "SCORING", scoringStartedAt: new Date(), scoringHeartbeatAt: new Date() },
  });
  if (claimed.count === 0) return true; // lost the race; caller loops again

  currentlyScoringJobId = nextJob.id;
  const heartbeatInterval = setInterval(() => {
    lastHeartbeat = new Date();
    void prisma.job.update({ where: { id: nextJob.id }, data: { scoringHeartbeatAt: new Date() } }).catch(() => {});
  }, 3000);

  try {
    await scorer(nextJob.id, { userId });
    await prisma.job.update({ where: { id: nextJob.id }, data: { scoringState: "SCORED", scoringFinishedAt: new Date(), scoringError: null } });
  } catch (err) {
    await prisma.job.update({ where: { id: nextJob.id }, data: { scoringState: "FAILED", scoringFinishedAt: new Date(), scoringError: err instanceof Error ? err.message : String(err) } });
  } finally {
    clearInterval(heartbeatInterval);
    currentlyScoringJobId = null;
  }
  return true;
}

export async function processScoringQueue(userId: string) {
  try {
    const processed = await scoreNextQueuedJob(userId);
    scoringWorkerTimer = processed ? setTimeout(() => void processScoringQueue(userId), 100) : null;
  } catch {
    scoringWorkerTimer = null;
  }
}

// Drain the entire queue to completion. Awaitable — used by tests and safe to
// call anywhere a synchronous full drain is wanted.
export async function drainScoringQueue(userId: string, maxJobs = 10_000): Promise<number> {
  let processed = 0;
  while (processed < maxJobs && (await scoreNextQueuedJob(userId))) processed++;
  return processed;
}
