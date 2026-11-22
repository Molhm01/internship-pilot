import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { jobsQueryErrorDevDetail, jobsQueryErrorLog } from "@/lib/jobs/jobsQueryError";
import { withUser } from "@/lib/auth/session";
import { ensureWorkspaceBootstrapped } from "@/lib/bootstrap";

async function getJobCountsResponse(userId: string) {
  await ensureWorkspaceBootstrapped(userId);
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
    total,
  ] = await Promise.all([
    prisma.job.count({ where: { activeFeed: true } }),
    prisma.job.count({ where: { activeFeed: true, verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK" } }),
    prisma.job.count({ where: { activeFeed: true, verificationStatus: "ACTIVE_SOURCE_LISTED" } }),
    prisma.job.count({ where: { activeFeed: true, verificationStatus: { in: ["VERIFICATION_PENDING", "Pending", "NeedsReview"] } } }),
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
