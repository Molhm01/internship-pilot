import { prisma } from "@/lib/db";
import { hasUsableJobDescription } from "@/lib/matchWorkflow";
import { scheduleAllUnscoredActiveJobs } from "@/lib/matching/bulkInitialMatch";
import {
  initialAiMatchWorkerConcurrency,
  processNextInitialAiMatch,
  usersEligibleForInitialMatch,
} from "@/lib/matching/initialAiMatchQueue";
import {
  approvedProfileRevision,
  originMatchesProfile,
  profileRefreshMatchType,
  PROFILE_REFRESH_MATCH_PREFIX,
} from "@/lib/matching/profileFingerprint";

const VALID_SCORE = { gte: 0, lte: 100 } as const;

export type ProfileRefreshScheduleResult = {
  userId: string;
  profileHash: string | null;
  considered: number;
  queued: number;
  alreadyCurrent: number;
  alreadyQueued: number;
  skippedNoDescription: number;
};

/**
 * Ensure every currently scored active job is grounded in the user's CURRENT
 * approved fact fingerprint. Old pending profile revisions are retired rather
 * than allowed to spend model calls after the profile changes again.
 */
export async function scheduleProfileRefreshesForUser(
  userId: string,
): Promise<ProfileRefreshScheduleResult> {
  const revision = await approvedProfileRevision(userId);
  if (!revision) {
    // With no approved evidence there is no defensible current score. Preserve
    // MatchResult history, but remove the denormalized current result.
    await prisma.userJobState.updateMany({
      where: { userId },
      data: { matchScore: null, eligibilityStatus: null, matchedAt: null },
    });
    return {
      userId,
      profileHash: null,
      considered: 0,
      queued: 0,
      alreadyCurrent: 0,
      alreadyQueued: 0,
      skippedNoDescription: 0,
    };
  }

  const matchType = profileRefreshMatchType(revision.hash);
  const now = new Date();

  await prisma.initialAiMatchJob.updateMany({
    where: {
      userId,
      matchType: { startsWith: PROFILE_REFRESH_MATCH_PREFIX },
      NOT: { matchType },
      state: { in: ["PENDING", "RETRYABLE_FAILED"] },
    },
    data: {
      state: "PERMANENT_FAILED",
      completedAt: now,
      lockedAt: null,
      lastErrorCode: "PROFILE_REVISION_SUPERSEDED",
    },
  });

  const jobs = await prisma.job.findMany({
    where: {
      activeFeed: true,
      userStates: { some: { userId, matchScore: VALID_SCORE } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      description: true,
      jobResponsibilities: true,
      jobQualifications: true,
      matchResults: {
        where: { userId, score: VALID_SCORE },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { origin: true },
      },
      initialAiMatchJobs: {
        where: { userId, matchType },
        take: 1,
        select: { id: true, state: true },
      },
    },
  });

  let queued = 0;
  let alreadyCurrent = 0;
  let alreadyQueued = 0;
  let skippedNoDescription = 0;

  for (const job of jobs) {
    const latest = job.matchResults[0];
    if (originMatchesProfile(latest?.origin, revision.hash)) {
      alreadyCurrent += 1;
      continue;
    }
    if (!hasUsableJobDescription(job)) {
      skippedNoDescription += 1;
      continue;
    }

    const existing = job.initialAiMatchJobs[0];
    if (existing && ["PENDING", "RUNNING", "SUCCEEDED"].includes(existing.state)) {
      alreadyQueued += 1;
      continue;
    }

    try {
      const queueWrite = existing
        ? prisma.initialAiMatchJob.update({
          where: { id: existing.id },
          data: {
            state: "PENDING",
            attemptCount: 0,
            nextAttemptAt: now,
            lockedAt: null,
            lastErrorCode: null,
            matchResultId: null,
            completedAt: null,
          },
        })
        : prisma.initialAiMatchJob.create({
          data: {
            userId,
            jobId: job.id,
            matchType,
            state: "PENDING",
            attemptCount: 0,
            nextAttemptAt: now,
          },
        });

      await prisma.$transaction([
        queueWrite,
        prisma.job.update({
          where: { id: job.id },
          data: {
            scoringState: "QUEUED",
            scoringQueuedAt: now,
            scoringError: null,
          },
        }),
      ]);
      queued += 1;
    } catch (error) {
      // A concurrent request can race us on the unique user/job/matchType key.
      // That means the desired current-profile work already exists.
      if (error && typeof error === "object" && "code" in error && String(error.code) === "P2002") {
        alreadyQueued += 1;
        continue;
      }
      throw error;
    }
  }

  return {
    userId,
    profileHash: revision.hash,
    considered: jobs.length,
    queued,
    alreadyCurrent,
    alreadyQueued,
    skippedNoDescription,
  };
}

export type AutomaticScoringPreparation = {
  users: number;
  initialQueued: number;
  refreshQueued: number;
};

/** Backstop run before every hosted worker: nothing depends on a button click. */
export async function prepareAutomaticScoringQueues(): Promise<AutomaticScoringPreparation> {
  const userIds = await usersEligibleForInitialMatch();
  let initialQueued = 0;
  let refreshQueued = 0;

  for (const userId of userIds) {
    const [initial, refresh] = await Promise.all([
      scheduleAllUnscoredActiveJobs(userId),
      scheduleProfileRefreshesForUser(userId),
    ]);
    initialQueued += initial.queued;
    refreshQueued += refresh.queued;
  }

  return { users: userIds.length, initialQueued, refreshQueued };
}

export type AutomaticScoringSweepResult = AutomaticScoringPreparation & {
  processed: number;
  timeBudgetReached: boolean;
};

/**
 * Process a bounded number of durable queue rows inside one Vercel function.
 * Each model call has its own timeout; the outer budget prevents a large first
 * deployment/profile refresh from trying to finish hundreds of jobs at once.
 */
export async function runAutomaticScoringSweep(options: {
  maxItems?: number;
  maxRuntimeMs?: number;
  concurrency?: number;
} = {}): Promise<AutomaticScoringSweepResult> {
  const preparation = await prepareAutomaticScoringQueues();
  const maxItems = Math.max(1, Math.min(100, Math.trunc(options.maxItems ?? 24)));
  const maxRuntimeMs = Math.max(30_000, Math.min(240_000, Math.trunc(options.maxRuntimeMs ?? 210_000)));
  const concurrency = Math.max(
    1,
    Math.min(2, Math.trunc(options.concurrency ?? initialAiMatchWorkerConcurrency())),
  );
  const deadline = Date.now() + maxRuntimeMs;
  let reserved = 0;
  let processed = 0;

  const worker = async () => {
    while (reserved < maxItems && Date.now() < deadline) {
      reserved += 1;
      const didWork = await processNextInitialAiMatch(new Date());
      if (!didWork) return;
      processed += 1;
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return {
    ...preparation,
    processed,
    timeBudgetReached: Date.now() >= deadline,
  };
}
