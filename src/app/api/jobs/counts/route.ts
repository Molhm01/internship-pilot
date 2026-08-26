import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { jobsQueryErrorDevDetail, jobsQueryErrorLog } from "@/lib/jobs/jobsQueryError";
import { withUser } from "@/lib/auth/session";
import { approvedProfileRevision } from "@/lib/matching/profileFingerprint";
import { backfillBaselineScoresForUser } from "@/lib/matching/baselineScoring";

// Authoritative, always-fresh counts for the Jobs header. Computed directly
// from stored state so the numbers can never drift from what the feed returns.
// no-store so a backfill/sync/repair is reflected immediately. There is no
// "Needs Review" pool counter — availability is reported as badges instead.
/**
 * The Jobs header counts.
 *
 * Split down the middle. Availability counts — active, verified, closed,
 * quarantined, total — describe the shared catalogue and are the same number
 * for everybody. Scoring and eligibility counts describe one person's progress
 * through it, and are computed from their own state rows.
 */
async function getJobCountsResponse(userId: string) {
  const revision = await approvedProfileRevision(userId);
  const profileReady = Boolean(revision);
  if (revision) {
    const missingCurrentScores = await prisma.job.count({
      where: {
        activeFeed: true,
        OR: [
          { userStates: { none: { userId } } },
          { userStates: { some: { userId, matchScore: null } } },
          { userStates: { some: { userId, scoreProfileRevision: null } } },
          { userStates: { some: { userId, scoreProfileRevision: { not: revision.hash } } } },
        ],
      },
    });
    if (missingCurrentScores > 0) await backfillBaselineScoresForUser(userId);
  }
  const [
    active,
    officiallyVerified,
    sourceListed,
    verificationPending,
    closedConfirmed,
    securityBlocked,
    scored,
    unscored,
    scoring,
    eligibilityPass,
    eligibilityFail,
    baselineScored,
    aiRefined,
    total,
  ] = await Promise.all([
    prisma.job.count({ where: { activeFeed: true } }),
    prisma.job.count({ where: { verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK" } }),
    prisma.job.count({ where: { verificationStatus: "ACTIVE_SOURCE_LISTED" } }),
    prisma.job.count({ where: { verificationStatus: { in: ["VERIFICATION_PENDING", "Pending", "NeedsReview"] } } }),
    prisma.job.count({ where: { verificationStatus: "Closed" } }),
    prisma.job.count({ where: { verificationStatus: "SecurityQuarantine" } }),
    prisma.job.count({
      where: { activeFeed: true, userStates: { some: { userId, matchScore: { not: null } } } },
    }),
    prisma.job.count({
      where: {
        activeFeed: true,
        OR: [
          { userStates: { none: { userId } } },
          { userStates: { some: { userId, matchScore: null } } },
        ],
      },
    }),
    prisma.job.count({
      where: {
        activeFeed: true,
        scoringState: { in: ["QUEUED", "SCORING", "RETRYABLE_FAILED"] },
      },
    }),
    prisma.job.count({
      where: { activeFeed: true, userStates: { some: { userId, eligibilityStatus: "Pass" } } },
    }),
    prisma.job.count({
      where: { activeFeed: true, userStates: { some: { userId, eligibilityStatus: "Fail" } } },
    }),
    prisma.job.count({
      where: { activeFeed: true, userStates: { some: { userId, scoreSource: "BASELINE" } } },
    }),
    prisma.job.count({
      where: { activeFeed: true, userStates: { some: { userId, scoreSource: "AI_REFINED" } } },
    }),
    prisma.job.count(),
  ]);
  return NextResponse.json(
    {
      active,
      officiallyVerified,
      sourceListed,
      verificationPending,
      closedConfirmed,
      securityBlocked,
      scored,
      unscored,
      scoring,
      eligibilityPass,
      eligibilityFail,
      baselineScored,
      aiRefined,
      profileReady,
      total,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export const GET = withUser(async (_request, user) => {
  try {
    return await getJobCountsResponse(user.id);
  } catch (error) {
    console.error("[api/jobs/counts] jobs count query failed", jobsQueryErrorLog(error));
    return NextResponse.json(
      {
        error: "The job summary could not be loaded because the database query failed.",
        code: "JOBS_COUNTS_QUERY_FAILED",
        dev: jobsQueryErrorDevDetail(error),
      },
      {
        status: 500,
        headers: { "cache-control": "no-store" },
      },
    );
  }
});
