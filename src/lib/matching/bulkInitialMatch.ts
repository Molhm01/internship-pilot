import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { scheduleInitialAiMatch } from "@/lib/matching/initialAiMatchQueue";

const VALID_SCORE = { gte: 0, lte: 100 };
/**
 * "Unscored" is a question about a person and a job, not about a job.
 *
 * The predicate used to read `Job.matchScore` — a single denormalized column on
 * the shared row — so once anybody had scored a posting it counted as scored
 * for everyone. It now asks whether THIS user has a valid score, through their
 * own `UserJobState` and their own `MatchResult` rows.
 */
function unscoredActiveWhere(userId: string): Prisma.JobWhereInput {
  return {
    activeFeed: true,
    AND: [
      {
        OR: [
          { userStates: { none: { userId } } },
          { userStates: { some: { userId, matchScore: null } } },
          { userStates: { some: { userId, matchScore: { lt: 0 } } } },
          { userStates: { some: { userId, matchScore: { gt: 100 } } } },
        ],
      },
      { matchResults: { none: { userId, score: VALID_SCORE } } },
    ],
  };
}

export type BulkInitialMatchScheduleResult = {
  ok: true;
  eligible: number;
  queued: number;
  skippedAlreadyScored: number;
  skippedAlreadyQueued: number;
  failedToQueue: number;
};

export type BulkInitialMatchStatus = {
  totalUnscored: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
};

export class BulkInitialMatchError extends Error {
  constructor(
    public readonly code:
      | "AI_MATCH_QUEUE_CLIENT_RESTART_REQUIRED"
      | "AI_MATCH_QUEUE_MIGRATION_REQUIRED"
      | "BULK_SCORE_QUERY_FAILED",
    public readonly operation: "queue migration check" | "unscored-job query" | "queue status query",
    public readonly status: number,
  ) {
    super(code);
    this.name = "BulkInitialMatchError";
  }
}

function databaseCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code);
    if (/^(P\d{4}|SQLITE_[A-Z_]+)$/.test(code)) return code;
  }
  return "DATABASE_ERROR";
}

function isMissingQueueMigration(error: unknown): boolean {
  const code = databaseCode(error);
  if (code === "P2021" || code === "P2022") return true;
  const message = error instanceof Error ? error.message : "";
  return /no such table.*InitialAiMatchJob|no such column.*matchType/i.test(message);
}

async function assertInitialAiMatchQueueReady(): Promise<void> {
  const queueDelegate = (prisma as unknown as {
    initialAiMatchJob?: { count(args: { where: { matchType: string } }): Promise<number> };
  }).initialAiMatchJob;
  if (!queueDelegate) {
    throw new BulkInitialMatchError(
      "AI_MATCH_QUEUE_CLIENT_RESTART_REQUIRED",
      "queue migration check",
      503,
    );
  }
  try {
    await queueDelegate.count({ where: { matchType: "INITIAL" } });
  } catch (error) {
    if (isMissingQueueMigration(error)) {
      throw new BulkInitialMatchError(
        "AI_MATCH_QUEUE_MIGRATION_REQUIRED",
        "queue migration check",
        503,
      );
    }
    throw new BulkInitialMatchError("BULK_SCORE_QUERY_FAILED", "queue migration check", 500);
  }
}

function logQueueFailure(jobId: string, error: unknown) {
  console.warn(JSON.stringify({
    event: "bulk-initial-ai-match",
    stage: "queue_failed",
    jobId,
    errorCode: databaseCode(error),
  }));
}

export async function scheduleAllUnscoredActiveJobs(
  userId: string,
): Promise<BulkInitialMatchScheduleResult> {
  await assertInitialAiMatchQueueReady();
  let activeCount: number;
  let jobs: Array<{ id: string }>;
  try {
    [activeCount, jobs] = await Promise.all([
      prisma.job.count({ where: { activeFeed: true } }),
      prisma.job.findMany({
        where: unscoredActiveWhere(userId),
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      }),
    ]);
  } catch {
    throw new BulkInitialMatchError("BULK_SCORE_QUERY_FAILED", "unscored-job query", 500);
  }

  let queued = 0;
  let skippedAlreadyQueued = 0;
  let skippedAlreadyScored = Math.max(0, activeCount - jobs.length);
  let failedToQueue = 0;
  for (const job of jobs) {
    try {
      const result = await scheduleInitialAiMatch(job.id, userId, {
        retryFailed: true,
        startWorker: false,
      });
      if (result.scheduled) queued += 1;
      else if (result.reason === "ALREADY_SCHEDULED") skippedAlreadyQueued += 1;
      else if (result.reason === "ALREADY_SCORED") skippedAlreadyScored += 1;
      else failedToQueue += 1;
    } catch (error) {
      if (databaseCode(error) === "P2002") skippedAlreadyQueued += 1;
      else failedToQueue += 1;
      logQueueFailure(job.id, error);
    }
  }

  return {
    ok: true,
    eligible: jobs.length,
    queued,
    skippedAlreadyScored,
    skippedAlreadyQueued,
    failedToQueue,
  };
}

export async function getBulkInitialMatchStatus(
  userId: string,
): Promise<BulkInitialMatchStatus> {
  await assertInitialAiMatchQueueReady();
  const activeInitialWork: Prisma.InitialAiMatchJobWhereInput = {
    job: { activeFeed: true },
    matchType: "INITIAL",
  };
  let counts: [number, number, number, number, number, number];
  try {
    counts = await Promise.all([
      prisma.job.count({ where: unscoredActiveWhere(userId) }),
      prisma.initialAiMatchJob.count({ where: { ...activeInitialWork, state: "PENDING" } }),
      prisma.initialAiMatchJob.count({ where: { ...activeInitialWork, state: "RUNNING" } }),
      prisma.initialAiMatchJob.count({ where: { ...activeInitialWork, state: "SUCCEEDED" } }),
      prisma.initialAiMatchJob.count({ where: { ...activeInitialWork, state: "RETRYABLE_FAILED" } }),
      prisma.initialAiMatchJob.count({ where: { ...activeInitialWork, state: "PERMANENT_FAILED" } }),
    ]);
  } catch {
    throw new BulkInitialMatchError("BULK_SCORE_QUERY_FAILED", "queue status query", 500);
  }
  const [totalUnscored, queued, running, completed, retryableFailed, permanentFailed] = counts;
  return {
    totalUnscored,
    queued,
    running,
    completed,
    failed: retryableFailed + permanentFailed,
  };
}
