import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { jobsQueryErrorDevDetail, jobsQueryErrorLog } from "@/lib/jobs/jobsQueryError";

// Authoritative, always-fresh counts for the Jobs header. Computed directly
// from stored state so the numbers can never drift from what the feed returns.
// no-store so a backfill/sync/repair is reflected immediately. There is no
// "Needs Review" pool counter — availability is reported as badges instead.
async function getJobCountsResponse() {
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
    prisma.job.count({ where: { verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK" } }),
    prisma.job.count({ where: { verificationStatus: "ACTIVE_SOURCE_LISTED" } }),
    prisma.job.count({ where: { verificationStatus: { in: ["VERIFICATION_PENDING", "Pending", "NeedsReview"] } } }),
    prisma.job.count({ where: { verificationStatus: "Closed" } }),
    prisma.job.count({ where: { verificationStatus: "SecurityQuarantine" } }),
    prisma.job.count({ where: { activeFeed: true, matchScore: { not: null } } }),
    prisma.job.count({ where: { activeFeed: true, matchScore: null } }),
    prisma.job.count({
      where: {
        activeFeed: true,
        scoringState: { in: ["QUEUED", "SCORING", "RETRYABLE_FAILED"] },
      },
    }),
    prisma.job.count({ where: { activeFeed: true, eligibilityStatus: "Pass" } }),
    prisma.job.count({ where: { activeFeed: true, eligibilityStatus: "Fail" } }),
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

export async function GET() {
  try {
    return await getJobCountsResponse();
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
}
