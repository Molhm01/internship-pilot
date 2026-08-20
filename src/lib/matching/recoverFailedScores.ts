import { prisma } from "@/lib/db";
import { hasUsableJobDescription } from "@/lib/matchWorkflow";

const RETRY_COOLDOWN_MS = 45 * 60 * 1000;
const RETRYABLE_TERMINAL_CODES = new Set([
  "MODEL_UNAVAILABLE",
  "MODEL_TIMEOUT",
  "MODEL_RESPONSE_INVALID",
  "CLOUD_MODEL_NOT_CONFIGURED",
  "MATCH_PERSISTENCE_FAILED",
  "TEMPORARY_DATABASE_FAILURE",
  "TEMPORARY_NETWORK_FAILURE",
  "TEMPORARY_FAILURE",
  "WORKER_INTERRUPTED",
  "MATCH_FAILED",
]);

export type FailedScoreRecoveryResult = {
  considered: number;
  requeued: number;
};

/**
 * Automatic scoring should be eventually consistent. A provider outage or one
 * malformed model response must not leave a job permanently unscored forever.
 *
 * We retry only a bounded batch, only after a cooldown, and only for jobs that
 * still have a usable description. The cooldown prevents a broken provider
 * from turning the 5-minute scheduler into a tight retry loop.
 */
export async function requeueStaleFailedScores(options: { maxItems?: number } = {}): Promise<FailedScoreRecoveryResult> {
  const maxItems = Math.max(1, Math.min(40, Math.trunc(options.maxItems ?? 16)));
  const now = new Date();
  const cutoff = new Date(now.getTime() - RETRY_COOLDOWN_MS);

  const failed = await prisma.initialAiMatchJob.findMany({
    where: {
      state: "PERMANENT_FAILED",
      completedAt: { lte: cutoff },
      NOT: { lastErrorCode: "PROFILE_REVISION_SUPERSEDED" },
    },
    orderBy: [{ completedAt: "asc" }, { createdAt: "asc" }],
    take: maxItems * 3,
    select: {
      id: true,
      jobId: true,
      lastErrorCode: true,
      job: {
        select: {
          activeFeed: true,
          description: true,
          jobResponsibilities: true,
          jobQualifications: true,
        },
      },
    },
  });

  const candidates = failed
    .filter((item) =>
      item.job.activeFeed
      && RETRYABLE_TERMINAL_CODES.has(item.lastErrorCode ?? "")
      && hasUsableJobDescription(item.job),
    )
    .slice(0, maxItems);

  let requeued = 0;
  for (const item of candidates) {
    const [, job] = await prisma.$transaction([
      prisma.initialAiMatchJob.updateMany({
        where: { id: item.id, state: "PERMANENT_FAILED" },
        data: {
          state: "PENDING",
          attemptCount: 0,
          nextAttemptAt: now,
          lockedAt: null,
          completedAt: null,
          lastErrorCode: null,
          matchResultId: null,
        },
      }),
      prisma.job.update({
        where: { id: item.jobId },
        data: {
          scoringState: "QUEUED",
          scoringQueuedAt: now,
          scoringStartedAt: null,
          scoringFinishedAt: null,
          scoringError: null,
        },
      }),
    ]);
    void job;
    requeued += 1;
  }

  return { considered: failed.length, requeued };
}
