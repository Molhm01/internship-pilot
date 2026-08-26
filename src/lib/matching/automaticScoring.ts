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
  originMatchesJobDescription,
  originMatchesProfile,
  profileRefreshMatchType,
  PROFILE_REFRESH_MATCH_PREFIX,
} from "@/lib/matching/profileFingerprint";
import {
  backfillBaselineScoresForUser,
  fingerprintJobScoringInput,
} from "@/lib/matching/baselineScoring";

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

function validCurrentScore(value: number | null | undefined): boolean {
  return Number.isInteger(value) && value! >= 0 && value! <= 100;
}

/**
 * Ensure every active job with historical score evidence is grounded in BOTH
 * the user's current approved-resume fingerprint and the current normalized job
 * description. Historical MatchResults remain append-only; UserJobState is only
 * the current display copy and is rebuilt whenever either input changes.
 */
export async function scheduleProfileRefreshesForUser(
  userId: string,
  options: { retryFailed?: boolean } = {},
): Promise<ProfileRefreshScheduleResult> {
  const revision = await approvedProfileRevision(userId);
  if (!revision) {
    // With no approved evidence there is no defensible personalized score.
    // The API returns the single profile-readiness block and no job cards; it
    // never destroys historical values merely to represent that UI state.
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
      matchResults: { some: { userId, score: VALID_SCORE } },
    },
    orderBy: [
      { sourcePostedAt: { sort: "desc", nulls: "last" } },
      { id: "desc" },
    ],
    select: {
      id: true,
      description: true,
      jobResponsibilities: true,
      jobQualifications: true,
      title: true,
      company: true,
      location: true,
      workplaceType: true,
      internshipTerm: true,
      disciplineTags: true,
      sophomoreEligible: true,
      graduationYears: true,
      sponsorship: true,
      citizenshipOrClearance: true,
      season: true,
      userStates: {
        where: { userId },
        take: 1,
        select: { matchScore: true },
      },
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
    const currentStateIsValid = validCurrentScore(job.userStates[0]?.matchScore);
    const usableDescription = hasUsableJobDescription(job);
    const currentDescriptionHash = usableDescription
      ? fingerprintJobScoringInput(job)
      : null;
    const scoreInputsAreCurrent = Boolean(
      currentDescriptionHash
      && originMatchesProfile(latest?.origin, revision.hash)
      && originMatchesJobDescription(latest?.origin, currentDescriptionHash),
    );

    if (scoreInputsAreCurrent && currentStateIsValid) {
      alreadyCurrent += 1;
      continue;
    }
    if (!usableDescription) {
      skippedNoDescription += 1;
      continue;
    }

    const existing = job.initialAiMatchJobs[0];
    if (existing && existing.state !== "SUCCEEDED") {
      const retryableByUser = Boolean(
        options.retryFailed
        && ["RETRYABLE_FAILED", "PERMANENT_FAILED"].includes(existing.state),
      );
      if (!retryableByUser) {
        // Automatic maintenance never resurrects terminal work. PENDING and
        // RUNNING are also already represented by the durable row.
        alreadyQueued += 1;
        continue;
      }
    }

    try {
      // A SUCCEEDED row can be safely reused only when its persisted current
      // state AND both input fingerprints are current (handled above). If the
      // JD or resume changed, recycle the durable row to rebuild the score.
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

export type AutomaticUserScheduleResult = {
  baselineScored: number;
  initialQueued: number;
  refreshQueued: number;
};

/**
 * Called after a profile mutation as well as by the hosted/local backstop. This
 * makes the first uploaded resume queue all active jobs and keeps every existing
 * score current when either the resume or the job description changes.
 */
export async function scheduleAutomaticScoresForUser(
  userId: string,
): Promise<AutomaticUserScheduleResult> {
  // This synchronous local-CPU pass is the display invariant. AI work is
  // optional refinement and is scheduled only after every active row is safe.
  const baseline = await backfillBaselineScoresForUser(userId);
  const [initial, refresh] = await Promise.all([
    // Automatic maintenance does not revive terminal failures every 30 min.
    scheduleAllUnscoredActiveJobs(userId, { retryFailed: false }),
    scheduleProfileRefreshesForUser(userId, { retryFailed: false }),
  ]);
  return {
    baselineScored: baseline.baselineWritten,
    initialQueued: initial.queued,
    refreshQueued: refresh.queued,
  };
}

export type AutomaticScoringPreparation = {
  users: number;
  initialQueued: number;
  refreshQueued: number;
};

/** Backstop run before every worker: nothing depends on a button click. */
export async function prepareAutomaticScoringQueues(): Promise<AutomaticScoringPreparation> {
  const userIds = await usersEligibleForInitialMatch();
  let initialQueued = 0;
  let refreshQueued = 0;

  for (const userId of userIds) {
    const scheduled = await scheduleAutomaticScoresForUser(userId);
    initialQueued += scheduled.initialQueued;
    refreshQueued += scheduled.refreshQueued;
  }

  return { users: userIds.length, initialQueued, refreshQueued };
}

export type AutomaticScoringSweepResult = AutomaticScoringPreparation & {
  processed: number;
  timeBudgetReached: boolean;
};

/**
 * Process a bounded number of durable queue rows inside one hosted function.
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
