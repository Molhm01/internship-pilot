import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIVE_TARGET = 500;

export async function GET() {
  const [active, total, verifiedActive, latestSync, bySource] = await Promise.all([
    prisma.job.count({ where: { activeFeed: true } }),
    prisma.job.count(),
    prisma.job.count({
      where: {
        activeFeed: true,
        verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
      },
    }),
    prisma.syncLog.findFirst({
      where: { source: "employer-ats", status: "success" },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true, newJobsCount: true, updatedJobsCount: true },
    }),
    prisma.job.groupBy({
      by: ["source"],
      where: { activeFeed: true },
      _count: { _all: true },
      orderBy: { _count: { source: "desc" } },
    }),
  ]);

  return NextResponse.json(
    {
      activeTarget: ACTIVE_TARGET,
      active,
      targetReached: active >= ACTIVE_TARGET,
      verifiedActive,
      total,
      lastSuccessfulSyncAt: latestSync?.finishedAt?.toISOString() ?? null,
      lastSyncNewJobs: latestSync?.newJobsCount ?? 0,
      lastSyncUpdatedJobs: latestSync?.updatedJobsCount ?? 0,
      activeBySource: bySource.map((row) => ({ source: row.source, count: row._count._all })),
    },
    { headers: { "cache-control": "no-store, max-age=0" } },
  );
}
