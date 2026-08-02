import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const lastLog = await prisma.syncLog.findFirst({
    where: { source: "intern-list", status: { in: ["success", "error"] } },
    orderBy: { startedAt: "desc" },
  });

  const recentErrorCount = await prisma.syncLog.count({
    where: {
      status: "error",
      startedAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });

  // Counts reflect every source (Intern List, nationwide ATS discovery,
  // nearby-firm discovery) — not just the original Phase 2 source.
  const [verifiedCount, needsReviewCount, closedCount, pendingCount] = await Promise.all([
    prisma.job.count({ where: { verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK" } }),
    prisma.job.count({ where: { verificationStatus: "NeedsReview" } }),
    prisma.job.count({ where: { verificationStatus: "Closed" } }),
    prisma.job.count({ where: { verificationStatus: "Pending" } }),
  ]);

  return NextResponse.json({
    lastSyncAt: lastLog?.finishedAt ?? null,
    lastSyncStatus: lastLog?.status ?? null,
    newJobsLastRun: lastLog?.newJobsCount ?? 0,
    updatedJobsLastRun: lastLog?.updatedJobsCount ?? 0,
    verifiedCount,
    needsReviewCount,
    closedCount,
    pendingCount,
    recentErrorCount,
  });
}
