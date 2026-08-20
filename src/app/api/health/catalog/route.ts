import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getLiveDiscoveryHealth } from "@/lib/sync/liveDiscoveryEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIVE_TARGET = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET() {
  try {
    const now = Date.now();
    const last24h = new Date(now - DAY_MS);
    const last72h = new Date(now - 3 * DAY_MS);
    const fourteenDaysAgo = new Date(now - 14 * DAY_MS);

    const [
      active,
      total,
      verifiedActive,
      fresh24h,
      fresh72h,
      olderThan14d,
      latestSync,
      bySource,
      liveDiscovery,
    ] = await Promise.all([
      prisma.job.count({ where: { activeFeed: true } }),
      prisma.job.count(),
      prisma.job.count({
        where: {
          activeFeed: true,
          verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
        },
      }),
      prisma.job.count({
        where: { activeFeed: true, sourcePostedAt: { gte: last24h } },
      }),
      prisma.job.count({
        where: { activeFeed: true, sourcePostedAt: { gte: last72h } },
      }),
      prisma.job.count({
        where: { activeFeed: true, sourcePostedAt: { lt: fourteenDaysAgo } },
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
      getLiveDiscoveryHealth(),
    ]);

    return NextResponse.json(
      {
        activeTarget: ACTIVE_TARGET,
        active,
        targetReached: active >= ACTIVE_TARGET,
        verifiedActive,
        total,
        freshness: {
          postedWithin24h: fresh24h,
          postedWithin72h: fresh72h,
          olderThan14Days: olderThan14d,
        },
        liveDiscovery,
        lastSuccessfulSyncAt: latestSync?.finishedAt?.toISOString() ?? null,
        lastSyncNewJobs: latestSync?.newJobsCount ?? 0,
        lastSyncUpdatedJobs: latestSync?.updatedJobsCount ?? 0,
        activeBySource: bySource.map((row) => ({ source: row.source, count: row._count._all })),
      },
      { headers: { "cache-control": "no-store, max-age=0" } },
    );
  } catch (error) {
    // Public health must never leak SQL, credentials or posting contents. Keep
    // enough server-side metadata to identify the failing layer while giving
    // monitoring a machine-readable response instead of an empty framework 500.
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "NONE")
      : "NONE";
    console.error("[health/catalog] catalog health failed", {
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: code,
    });
    return NextResponse.json(
      {
        ok: false,
        error: "Catalog health is temporarily unavailable.",
        code: "CATALOG_HEALTH_FAILED",
      },
      { status: 503, headers: { "cache-control": "no-store, max-age=0" } },
    );
  }
}
