/*
 * Shared data, but not public data.
 *
 * The Discover status panel reports the canonical employer/public-authority
 * sync, not the secondary Intern-List enrichment feed.
 */
import { guardSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const ACTIVE_TARGET = 500;

export async function GET() {
  const denied = await guardSession();
  if (denied) return denied;
  const lastLog = await prisma.syncLog.findFirst({
    where: { source: "employer-ats", status: { in: ["success", "error"] } },
    orderBy: { startedAt: "desc" },
  });

  const recentErrorCount = await prisma.syncLog.count({
    where: {
      source: "employer-ats",
      status: "error",
      startedAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });

  const [activeCount, verifiedCount, needsReviewCount, closedCount, pendingCount] = await Promise.all([
    prisma.job.count({ where: { activeFeed: true } }),
    prisma.job.count({ where: { activeFeed: true, verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK" } }),
    prisma.job.count({ where: { activeFeed: false, verificationStatus: "NeedsReview" } }),
    prisma.job.count({ where: { verificationStatus: "Closed" } }),
    prisma.job.count({ where: { activeFeed: false, verificationStatus: "Pending" } }),
  ]);

  return NextResponse.json({
    lastSyncAt: lastLog?.finishedAt ?? null,
    lastSyncStatus: lastLog?.status ?? null,
    newJobsLastRun: lastLog?.newJobsCount ?? 0,
    updatedJobsLastRun: lastLog?.updatedJobsCount ?? 0,
    activeCount,
    activeTarget: ACTIVE_TARGET,
    activeTargetReached: activeCount >= ACTIVE_TARGET,
    verifiedCount,
    needsReviewCount,
    closedCount,
    pendingCount,
    recentErrorCount,
  });
}
