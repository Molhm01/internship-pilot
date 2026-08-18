/*
 * Shared data, but not public data.
 *
 * The Discover status panel reports canonical active-catalog health, including
 * both total coverage and source-posting freshness.
 */
import { guardSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const ACTIVE_TARGET = 500;
const FRESH_24H_TARGET = 25;
const FRESH_72H_TARGET = 75;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET() {
  const denied = await guardSession();
  if (denied) return denied;
  const [lastLog, lastFreshLog] = await Promise.all([
    prisma.syncLog.findFirst({
      where: { source: "employer-ats", status: { in: ["success", "error"] } },
      orderBy: { startedAt: "desc" },
    }),
    prisma.syncLog.findFirst({
      where: { source: "fresh-discovery", status: { in: ["success", "error"] } },
      orderBy: { startedAt: "desc" },
    }),
  ]);

  const now = Date.now();
  const recentErrorCount = await prisma.syncLog.count({
    where: {
      source: { in: ["employer-ats", "fresh-discovery"] },
      status: "error",
      startedAt: { gt: new Date(now - DAY_MS) },
    },
  });

  const [
    activeCount,
    fresh24hCount,
    fresh72hCount,
    latestSourceJob,
    verifiedCount,
    needsReviewCount,
    closedCount,
    pendingCount,
  ] = await Promise.all([
    prisma.job.count({ where: { activeFeed: true } }),
    prisma.job.count({
      where: { activeFeed: true, sourcePostedAt: { gte: new Date(now - DAY_MS) } },
    }),
    prisma.job.count({
      where: { activeFeed: true, sourcePostedAt: { gte: new Date(now - 3 * DAY_MS) } },
    }),
    prisma.job.findFirst({
      where: { activeFeed: true, sourcePostedAt: { not: null } },
      orderBy: { sourcePostedAt: "desc" },
      select: { sourcePostedAt: true },
    }),
    prisma.job.count({ where: { activeFeed: true, verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK" } }),
    prisma.job.count({ where: { activeFeed: false, verificationStatus: "NeedsReview" } }),
    prisma.job.count({ where: { verificationStatus: "Closed" } }),
    prisma.job.count({ where: { activeFeed: false, verificationStatus: "Pending" } }),
  ]);

  return NextResponse.json({
    lastSyncAt: lastLog?.finishedAt ?? null,
    lastSyncStatus: lastLog?.status ?? null,
    lastFreshSyncAt: lastFreshLog?.finishedAt ?? null,
    lastFreshSyncStatus: lastFreshLog?.status ?? null,
    newJobsLastRun: lastLog?.newJobsCount ?? 0,
    updatedJobsLastRun: lastLog?.updatedJobsCount ?? 0,
    activeCount,
    activeTarget: ACTIVE_TARGET,
    activeTargetReached: activeCount >= ACTIVE_TARGET,
    fresh24hCount,
    fresh72hCount,
    fresh24hTarget: FRESH_24H_TARGET,
    fresh72hTarget: FRESH_72H_TARGET,
    freshnessTargetReached: fresh24hCount >= FRESH_24H_TARGET && fresh72hCount >= FRESH_72H_TARGET,
    latestSourcePostedAt: latestSourceJob?.sourcePostedAt ?? null,
    verifiedCount,
    needsReviewCount,
    closedCount,
    pendingCount,
    recentErrorCount,
  });
}
