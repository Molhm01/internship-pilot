import { freemem } from "node:os";
import { prisma } from "@/lib/db";
import { isCloudRuntime } from "@/lib/runtime/deployment";
import { MatchError, runMatchForJob, type MatchOrigin } from "@/lib/matching";
import { hasUsableJobDescription } from "@/lib/matchWorkflow";
import {
  approvedProfileRevision,
  profileHashFromRefreshMatchType,
  profileRefreshMatchType,
  PROFILE_REFRESH_MATCH_PREFIX,
} from "@/lib/matching/profileFingerprint";

export const INITIAL_MATCH_TYPE = "INITIAL";
export const INITIAL_MATCH_ORIGIN: MatchOrigin = "INITIAL_AUTO";
export const PROFILE_REFRESH_ORIGIN: MatchOrigin = "PROFILE_AUTO";
export const INITIAL_MATCH_MAX_ATTEMPTS = 3;
export const INITIAL_MATCH_RETRY_DELAYS_MS = [60_000, 5 * 60_000] as const;
export const DEFAULT_AI_MATCH_WORKER_CONCURRENCY = 2;
export const AI_MATCH_MIN_FREE_MEMORY_PER_WORKER_BYTES = 4 * 1024 ** 3;

/** 0 is highest priority; unknown dates are deliberately last. */
export function aiQueueFreshnessBucket(
  sourcePostedAt: Date | string | null | undefined,
  now = new Date(),
): 0 | 1 | 2 | 3 | 4 | 5 {
  if (!sourcePostedAt) return 5;
  const posted = sourcePostedAt instanceof Date ? sourcePostedAt : new Date(sourcePostedAt);
  if (Number.isNaN(posted.getTime())) return 5;
  const ageMs = Math.max(0, now.getTime() - posted.getTime());
  if (ageMs < 24 * 60 * 60 * 1000) return 0;
  if (ageMs < 72 * 60 * 60 * 1000) return 1;
  if (ageMs <= 7 * 24 * 60 * 60 * 1000) return 2;
  if (ageMs <= 14 * 24 * 60 * 60 * 1000) return 3;
  return 4;
}

export function compareAiQueueFreshness(
  a: { sourcePostedAt?: Date | string | null; id?: string },
  b: { sourcePostedAt?: Date | string | null; id?: string },
  now = new Date(),
): number {
  const bucket = aiQueueFreshnessBucket(a.sourcePostedAt, now) - aiQueueFreshnessBucket(b.sourcePostedAt, now);
  if (bucket !== 0) return bucket;
  const aMs = a.sourcePostedAt ? new Date(a.sourcePostedAt).getTime() : -Infinity;
  const bMs = b.sourcePostedAt ? new Date(b.sourcePostedAt).getTime() : -Infinity;
  if (aMs !== bMs) return bMs - aMs;
  return (b.id ?? "").localeCompare(a.id ?? "");
}

type InitialMatchState =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "RETRYABLE_FAILED"
  | "PERMANENT_FAILED";

export type InitialMatchScheduleResult = {
  scheduled: boolean;
  reason:
    | "SCHEDULED"
    | "JOB_NOT_FOUND"
    | "JOB_NOT_ACTIVE"
    | "ALREADY_SCORED"
    | "ALREADY_SCHEDULED"
    | "JOB_DESCRIPTION_INSUFFICIENT"
    | "PROFILE_FACTS_MISSING";
};

export type InitialMatchScheduleOptions = {
  retryFailed?: boolean;
  startWorker?: boolean;
};

type PersistedMatch = {
  id: string;
  score: number;
  eligibility: string;
  eligibilityReason: string;
  explanation: string;
  skillsSupported: string;
  skillsNeedConfirmation: string;
  skillsToLearn: string;
  skillsNeverAdd: string;
  origin?: string | null;
};

type InitialScorer = (
  jobId: string,
  options: { userId: string; origin: MatchOrigin },
) => Promise<PersistedMatch>;

let scorer: InitialScorer = runMatchForJob;
let workerRun: Promise<void> | null = null;

function progress(stage: string, details: Record<string, unknown>) {
  console.info(JSON.stringify({ event: "initial-ai-match", stage, ...details }));
}

function timing(stage: string, details: Record<string, number | string>) {
  if (process.env.NODE_ENV !== "development") return;
  console.info(JSON.stringify({ event: "initial-ai-match-timing", stage, ...details }));
}

export function initialAiMatchWorkerConcurrency(
  configured = process.env.AI_MATCH_WORKER_CONCURRENCY,
  freeMemoryBytes = freemem(),
): number {
  const parsed = Number(configured ?? DEFAULT_AI_MATCH_WORKER_CONCURRENCY);
  const requested = Number.isInteger(parsed) ? Math.max(1, Math.min(2, parsed)) : DEFAULT_AI_MATCH_WORKER_CONCURRENCY;
  return requested > 1 && freeMemoryBytes < AI_MATCH_MIN_FREE_MEMORY_PER_WORKER_BYTES * requested
    ? 1
    : requested;
}

function isUniqueConstraint(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "P2002");
}

function validJsonArray(value: string): boolean {
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}

function isCompleteAutomaticMatch(match: PersistedMatch, expectedOrigin: MatchOrigin): boolean {
  const originOk = match.origin === expectedOrigin || match.origin?.startsWith(`${expectedOrigin}:`) === true;
  return Number.isInteger(match.score)
    && match.score >= 0
    && match.score <= 100
    && typeof match.eligibility === "string"
    && match.eligibility.length > 0
    && typeof match.eligibilityReason === "string"
    && match.eligibilityReason.length > 0
    && typeof match.explanation === "string"
    && match.explanation.length > 0
    && validJsonArray(match.skillsSupported)
    && validJsonArray(match.skillsNeedConfirmation)
    && validJsonArray(match.skillsToLearn)
    && validJsonArray(match.skillsNeverAdd)
    && originOk;
}

// Kept as the public compatibility helper used by the existing queue tests.
export function isCompleteInitialMatch(match: PersistedMatch): boolean {
  return isCompleteAutomaticMatch(match, INITIAL_MATCH_ORIGIN);
}

/** Queue the first automatic score of a genuinely unscored job for one user. */
export async function scheduleInitialAiMatch(
  jobId: string,
  userId: string,
  options: InitialMatchScheduleOptions = {},
): Promise<InitialMatchScheduleResult> {
  const [job, approvedFactCount] = await Promise.all([
    prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        activeFeed: true,
        description: true,
        jobResponsibilities: true,
        jobQualifications: true,
        matchResults: {
          where: { userId, score: { gte: 0, lte: 100 } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true },
        },
        userStates: {
          where: { userId },
          take: 1,
          select: { matchScore: true, scoreSource: true },
        },
        initialAiMatchJobs: {
          where: {
            userId,
            OR: [
              { matchType: INITIAL_MATCH_TYPE },
              { matchType: { startsWith: PROFILE_REFRESH_MATCH_PREFIX } },
            ],
          },
          select: { id: true, state: true, matchType: true },
        },
      },
    }),
    prisma.resumeFact.count({ where: { userId, status: { in: ["approved", "edited"] } } }),
  ]);

  if (!job) return { scheduled: false, reason: "JOB_NOT_FOUND" };
  if (!job.activeFeed) return { scheduled: false, reason: "JOB_NOT_ACTIVE" };
  const existingScore = job.userStates[0]?.matchScore ?? null;
  const existingSource = job.userStates[0]?.scoreSource ?? null;
  const validExistingScore = Number.isInteger(existingScore)
    && existingScore! >= 0
    && existingScore! <= 100;
  if (
    (existingSource === "AI_REFINED" && validExistingScore)
    || (job.matchResults.length > 0 && existingSource !== "BASELINE")
    || (validExistingScore && existingSource === null)
  ) {
    return { scheduled: false, reason: "ALREADY_SCORED" };
  }
  if (approvedFactCount === 0) return { scheduled: false, reason: "PROFILE_FACTS_MISSING" };
  const refreshRevision = job.matchResults.length > 0
    ? await approvedProfileRevision(userId)
    : null;
  const matchType = refreshRevision
    ? profileRefreshMatchType(refreshRevision.hash)
    : INITIAL_MATCH_TYPE;
  const existingWork = job.initialAiMatchJobs.find((item) =>
    item.matchType === matchType || (matchType === INITIAL_MATCH_TYPE && !item.matchType));
  if (existingWork && !(
    options.retryFailed
    && ["RETRYABLE_FAILED", "PERMANENT_FAILED"].includes(existingWork.state)
  )) {
    return { scheduled: false, reason: "ALREADY_SCHEDULED" };
  }
  if (!hasUsableJobDescription(job)) {
    return { scheduled: false, reason: "JOB_DESCRIPTION_INSUFFICIENT" };
  }

  try {
    const queuedAt = new Date();
    const queueWrite = existingWork
      ? prisma.initialAiMatchJob.update({
        where: { id: existingWork.id },
        data: {
          state: "PENDING",
          attemptCount: 0,
          nextAttemptAt: queuedAt,
          lockedAt: null,
          lastErrorCode: null,
          matchResultId: null,
          completedAt: null,
        },
      })
      : prisma.initialAiMatchJob.create({
        data: {
          userId,
          jobId,
          matchType,
          state: "PENDING",
          attemptCount: 0,
          nextAttemptAt: queuedAt,
        },
      });
    await prisma.$transaction([
      queueWrite,
      prisma.job.update({
        where: { id: jobId },
        data: {
          scoringState: "QUEUED",
          scoringQueuedAt: queuedAt,
          scoringError: null,
        },
      }),
    ]);
  } catch (error) {
    if (isUniqueConstraint(error)) {
      return { scheduled: false, reason: "ALREADY_SCHEDULED" };
    }
    throw error;
  }

  progress("scheduled", { jobId, userId, matchType });
  if (options.startWorker !== false) triggerInitialAiMatchWorker();
  return { scheduled: true, reason: "SCHEDULED" };
}

export async function usersEligibleForInitialMatch(): Promise<string[]> {
  const rows = await prisma.resumeFact.findMany({
    where: { userId: { not: null }, status: { in: ["approved", "edited"] } },
    distinct: ["userId"],
    select: { userId: true },
  });
  return rows.map((row) => row.userId).filter((id): id is string => Boolean(id));
}

export async function scheduleInitialAiMatchForAllUsers(
  jobId: string,
  options: InitialMatchScheduleOptions = {},
): Promise<{ scheduled: number; considered: number }> {
  const userIds = await usersEligibleForInitialMatch();
  let scheduled = 0;
  for (const userId of userIds) {
    try {
      const result = await scheduleInitialAiMatch(jobId, userId, options);
      if (result.scheduled) scheduled += 1;
    } catch (error) {
      console.error("[initial-ai-match] scheduling failed for one user", {
        jobId,
        userId,
        errorCode:
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "SCHEDULE_FAILED",
      });
    }
  }
  return { scheduled, considered: userIds.length };
}

const TRANSIENT_ERROR_CODES = new Set([
  "MODEL_UNAVAILABLE",
  "MODEL_TIMEOUT",
  "CLOUD_MODEL_NOT_CONFIGURED",
  "MATCH_PERSISTENCE_FAILED",
  "TEMPORARY_DATABASE_FAILURE",
  "TEMPORARY_NETWORK_FAILURE",
  "WORKER_INTERRUPTED",
]);

function safeErrorCode(error: unknown): string {
  if (error instanceof MatchError && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)) {
    return error.code;
  }
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
  if (typeof code === "string" && /^P\d{4}$/.test(code)) return "TEMPORARY_DATABASE_FAILURE";
  if (error instanceof TypeError) return "TEMPORARY_NETWORK_FAILURE";
  return "TEMPORARY_FAILURE";
}

function isTransient(error: unknown, code: string): boolean {
  if (TRANSIENT_ERROR_CODES.has(code)) return true;
  if (code === "TEMPORARY_FAILURE") return true;
  return error instanceof MatchError && error.status >= 500 && code !== "MODEL_RESPONSE_INVALID";
}

async function recoverAbandonedInitialMatches(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - 2 * 60_000);
  const abandoned = await prisma.initialAiMatchJob.findMany({
    where: { state: "RUNNING", lockedAt: { lt: cutoff } },
    select: { id: true, jobId: true, attemptCount: true },
  });
  for (const item of abandoned) {
    const terminal = item.attemptCount >= INITIAL_MATCH_MAX_ATTEMPTS;
    await prisma.$transaction([
      prisma.initialAiMatchJob.update({
        where: { id: item.id },
        data: {
          state: terminal ? "PERMANENT_FAILED" : "RETRYABLE_FAILED",
          nextAttemptAt: now,
          lockedAt: null,
          lastErrorCode: "WORKER_INTERRUPTED",
          ...(terminal ? { completedAt: now } : {}),
        },
      }),
      prisma.job.update({
        where: { id: item.jobId },
        data: {
          scoringState: terminal ? "FAILED" : "RETRYABLE_FAILED",
          scoringError: "WORKER_INTERRUPTED",
        },
      }),
    ]);
  }
}

async function retireSupersededProfileRefresh(itemId: string, now: Date): Promise<void> {
  await prisma.initialAiMatchJob.update({
    where: { id: itemId },
    data: {
      state: "PERMANENT_FAILED",
      completedAt: now,
      lockedAt: null,
      lastErrorCode: "PROFILE_REVISION_SUPERSEDED",
    },
  });
}

export async function processNextInitialAiMatch(now = new Date()): Promise<boolean> {
  const queueReadStartedAt = performance.now();
  await recoverAbandonedInitialMatches(now);
  const item = await prisma.initialAiMatchJob.findFirst({
    where: {
      OR: [
        { matchType: INITIAL_MATCH_TYPE },
        { matchType: { startsWith: PROFILE_REFRESH_MATCH_PREFIX } },
      ],
      state: { in: ["PENDING", "RETRYABLE_FAILED"] },
      nextAttemptAt: { lte: now },
      job: { activeFeed: true },
    },
    // sourcePostedAt DESC is a strict refinement of the required freshness
    // buckets (<24h, <72h, <=7d, 8-14d, older, unknown). Crucially it precedes
    // queue creation/retry time, so historical backlog can never starve a job
    // posted minutes ago.
    orderBy: [
      { job: { sourcePostedAt: { sort: "desc", nulls: "last" } } },
      { nextAttemptAt: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ],
    select: {
      id: true,
      userId: true,
      jobId: true,
      matchType: true,
      state: true,
      attemptCount: true,
      createdAt: true,
    },
  });
  if (!item) return false;

  if (!item.userId) {
    await prisma.initialAiMatchJob.update({
      where: { id: item.id },
      data: { state: "PERMANENT_FAILED", lastErrorCode: "OWNER_UNKNOWN", completedAt: now, lockedAt: null },
    });
    return true;
  }

  // Queue rows created before matchType became explicit — and old unit-test
  // fixtures that model those rows — are INITIAL work by definition.
  const matchType = item.matchType ?? INITIAL_MATCH_TYPE;
  const profileRefreshHash = profileHashFromRefreshMatchType(matchType);
  if (matchType !== INITIAL_MATCH_TYPE) {
    const revision = await approvedProfileRevision(item.userId);
    if (!profileRefreshHash || !revision || revision.hash !== profileRefreshHash) {
      await retireSupersededProfileRefresh(item.id, now);
      progress("profile_refresh_superseded", { jobId: item.jobId, userId: item.userId });
      return true;
    }
  }

  const claimStartedAt = performance.now();
  const claimed = await prisma.initialAiMatchJob.updateMany({
    where: { id: item.id, state: item.state, nextAttemptAt: { lte: now } },
    data: { state: "RUNNING", lockedAt: now, attemptCount: { increment: 1 } },
  });
  if (claimed.count === 0) return true;
  timing("queue_claimed", {
    jobId: item.jobId,
    queueWaitMs: item.createdAt instanceof Date
      ? Math.max(0, now.getTime() - item.createdAt.getTime())
      : 0,
    queueReadMs: Math.round(claimStartedAt - queueReadStartedAt),
    claimWriteMs: Math.round(performance.now() - claimStartedAt),
  });

  const attemptNumber = item.attemptCount + 1;
  await prisma.job.update({
    where: { id: item.jobId },
    data: {
      scoringState: "SCORING",
      scoringStartedAt: now,
      scoringHeartbeatAt: now,
      scoringError: null,
    },
  });
  progress("started", { jobId: item.jobId, userId: item.userId, matchType, attempt: attemptNumber });

  try {
    const scoreStartedAt = performance.now();
    const job = await prisma.job.findUnique({
      where: { id: item.jobId },
      select: {
        matchResults: {
          where: { userId: item.userId, score: { gte: 0, lte: 100 } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true },
        },
      },
    });
    const existingMatch = job?.matchResults[0];

    // INITIAL means "score once". PROFILE_REFRESH intentionally ignores the
    // old MatchResult and creates a new version grounded in the new fact set.
    if (matchType === INITIAL_MATCH_TYPE && existingMatch) {
      await prisma.$transaction([
        prisma.initialAiMatchJob.update({
          where: { id: item.id },
          data: {
            state: "SUCCEEDED",
            matchResultId: existingMatch.id,
            completedAt: now,
            lockedAt: null,
            lastErrorCode: null,
          },
        }),
        prisma.job.update({
          where: { id: item.jobId },
          data: { scoringState: "SCORED", scoringFinishedAt: now, scoringError: null },
        }),
      ]);
      progress("skipped_existing_score", { jobId: item.jobId, userId: item.userId, attempt: attemptNumber });
      return true;
    }

    const matchOrigin = matchType === INITIAL_MATCH_TYPE
      ? INITIAL_MATCH_ORIGIN
      : PROFILE_REFRESH_ORIGIN;
    const match = await scorer(item.jobId, { userId: item.userId, origin: matchOrigin });
    if (!isCompleteAutomaticMatch(match, matchOrigin)) {
      throw new MatchError(
        "The automatic AI Match result was incomplete.",
        502,
        "MODEL_RESPONSE_INVALID",
      );
    }
    await prisma.$transaction([
      prisma.initialAiMatchJob.update({
        where: { id: item.id },
        data: {
          state: "SUCCEEDED",
          matchResultId: match.id,
          completedAt: now,
          lockedAt: null,
          lastErrorCode: null,
        },
      }),
      prisma.job.update({
        where: { id: item.jobId },
        data: { scoringState: "SCORED", scoringFinishedAt: now, scoringError: null },
      }),
    ]);
    timing("queue_completed", {
      jobId: item.jobId,
      scoringMs: Math.round(performance.now() - scoreStartedAt),
      attempt: attemptNumber,
    });
    progress("succeeded", { jobId: item.jobId, userId: item.userId, matchType, attempt: attemptNumber });
  } catch (error) {
    const errorCode = safeErrorCode(error);
    const retryable = isTransient(error, errorCode) && attemptNumber < INITIAL_MATCH_MAX_ATTEMPTS;
    const nextAttemptAt = retryable
      ? new Date(now.getTime() + INITIAL_MATCH_RETRY_DELAYS_MS[attemptNumber - 1])
      : now;
    const state: InitialMatchState = retryable ? "RETRYABLE_FAILED" : "PERMANENT_FAILED";
    await prisma.$transaction([
      prisma.initialAiMatchJob.update({
        where: { id: item.id },
        data: {
          state,
          nextAttemptAt,
          lockedAt: null,
          lastErrorCode: errorCode,
          ...(!retryable ? { completedAt: now } : {}),
        },
      }),
      prisma.job.update({
        where: { id: item.jobId },
        data: {
          scoringState: retryable ? "RETRYABLE_FAILED" : "FAILED",
          scoringFinishedAt: now,
          scoringError: errorCode,
        },
      }),
    ]);
    progress(retryable ? "retry_scheduled" : "permanent_failure", {
      jobId: item.jobId,
      userId: item.userId,
      matchType,
      attempt: attemptNumber,
      errorCode,
      ...(retryable ? { retryAt: nextAttemptAt.toISOString() } : {}),
    });
  }
  return true;
}

export async function runBoundedInitialMatchWorkers(
  processor: () => Promise<boolean> = () => processNextInitialAiMatch(),
  concurrency = initialAiMatchWorkerConcurrency(),
): Promise<void> {
  const bounded = Math.max(1, Math.min(2, Math.trunc(concurrency)));
  await Promise.all(Array.from({ length: bounded }, async () => {
    while (await processor()) {
      // Immediately claim the next durable item. Future retries are picked up
      // by the next scheduled worker once nextAttemptAt is due.
    }
  }));
}

export function triggerInitialAiMatchWorker() {
  // ATS scoring runs on Ollama, which lives on the user's own computer. In a
  // cloud runtime `localhost:11434` is the serverless function itself, so a
  // worker started there does not fail fast — it spends the invocation timing
  // out against a port nobody is listening on. Discovery already schedules
  // scoring with `startWorker: false`; this is the guarantee rather than the
  // convention, so a future hosted caller cannot reintroduce the problem.
  if (isCloudRuntime()) {
    progress("worker_skipped_cloud_runtime", {});
    return;
  }
  if (workerRun) return;
  const concurrency = initialAiMatchWorkerConcurrency();
  progress("worker_started", { concurrency });
  workerRun = runBoundedInitialMatchWorkers(undefined, concurrency)
    .catch((error) => {
      progress("worker_paused", { errorCode: safeErrorCode(error) });
    })
    .finally(() => {
      workerRun = null;
    });
}

export function __setInitialAiMatchScorerForTests(next: InitialScorer | null) {
  scorer = next ?? runMatchForJob;
}

export function __stopInitialAiMatchWorkerForTests() {
  workerRun = null;
}
