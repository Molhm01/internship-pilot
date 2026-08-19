import { prisma } from "@/lib/db";
import { hasUsableJobDescription } from "@/lib/matchWorkflow";
import {
  approvedProfileRevision,
  profileRefreshMatchType,
  PROFILE_REFRESH_MATCH_PREFIX,
} from "@/lib/matching/profileFingerprint";
import { INITIAL_MATCH_TYPE } from "@/lib/matching/initialAiMatchQueue";

export type ResumeUploadQueueResult = {
  activeJobs: number;
  eligibleJobs: number;
  queuedRows: number;
  skippedNoDescription: number;
};

/**
 * Queue the entire active catalogue for the newly activated resume in bulk.
 *
 * Jobs with no history use INITIAL. Jobs with historical MatchResults get a
 * profile-hash-specific refresh row so their old score remains append-only
 * history while the current display score is rebuilt from the new resume.
 */
export async function queueEntireCatalogForResume(userId: string): Promise<ResumeUploadQueueResult> {
  const revision = await approvedProfileRevision(userId);
  if (!revision) {
    return { activeJobs: 0, eligibleJobs: 0, queuedRows: 0, skippedNoDescription: 0 };
  }

  const jobs = await prisma.job.findMany({
    where: { activeFeed: true },
    orderBy: [{ sourcePostedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      description: true,
      jobResponsibilities: true,
      jobQualifications: true,
      matchResults: {
        where: { userId, score: { gte: 0, lte: 100 } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true },
      },
    },
  });

  const eligible = jobs.filter((job) => hasUsableJobDescription(job));
  const now = new Date();
  const refreshType = profileRefreshMatchType(revision.hash);

  const rows = eligible.map((job) => ({
    userId,
    jobId: job.id,
    matchType: job.matchResults.length > 0 ? refreshType : INITIAL_MATCH_TYPE,
    state: "PENDING",
    attemptCount: 0,
    nextAttemptAt: now,
  }));

  const eligibleIds = eligible.map((job) => job.id);
  const [, resetFailedInitial, , created] = await prisma.$transaction([
    // Any pending refresh for a previous resume revision is obsolete.
    prisma.initialAiMatchJob.updateMany({
      where: {
        userId,
        matchType: { startsWith: PROFILE_REFRESH_MATCH_PREFIX },
        NOT: { matchType: refreshType },
        state: { in: ["PENDING", "RETRYABLE_FAILED"] },
      },
      data: {
        state: "PERMANENT_FAILED",
        completedAt: now,
        lockedAt: null,
        lastErrorCode: "PROFILE_REVISION_SUPERSEDED",
      },
    }),
    // A new resume is an explicit reason to retry old terminal INITIAL work.
    prisma.initialAiMatchJob.updateMany({
      where: {
        userId,
        matchType: INITIAL_MATCH_TYPE,
        jobId: { in: eligibleIds },
        state: { in: ["RETRYABLE_FAILED", "PERMANENT_FAILED"] },
      },
      data: {
        state: "PENDING",
        attemptCount: 0,
        nextAttemptAt: now,
        lockedAt: null,
        lastErrorCode: null,
        matchResultId: null,
        completedAt: null,
      },
    }),
    prisma.job.updateMany({
      where: { id: { in: eligibleIds } },
      data: {
        scoringState: "QUEUED",
        scoringQueuedAt: now,
        scoringError: null,
      },
    }),
    prisma.initialAiMatchJob.createMany({
      data: rows,
      skipDuplicates: true,
    }),
  ]);

  return {
    activeJobs: jobs.length,
    eligibleJobs: eligible.length,
    queuedRows: created.count + resetFailedInitial.count,
    skippedNoDescription: jobs.length - eligible.length,
  };
}
