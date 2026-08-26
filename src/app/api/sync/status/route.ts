/*
 * Shared data, but not public data.
 *
 * The Discover status panel reports canonical active-catalog health, including
 * both total coverage and source-posting freshness.
 */
import { guardSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { getCachedCatalogHealth } from "@/lib/sync/liveDiscoveryHealthCache";

const FRESH_24H_TARGET = 25;
const FRESH_72H_TARGET = 75;

export async function GET(request: Request) {
  const denied = await guardSession();
  if (denied) return denied;

  // A manual "Run sync now" click wants to see the effect of what it just
  // did, not a value that may be up to 90s stale — everything else (the
  // 5-minute polling interval in SyncStatusPanel) is happy with the shared
  // cache. See src/lib/sync/liveDiscoveryHealthCache.ts.
  const force = new URL(request.url).searchParams.get("fresh") === "1";
  const { health, computedAt, fresh } = await getCachedCatalogHealth({ force });
  const liveDiscovery = health.liveDiscovery;

  return NextResponse.json({
    lastSyncAt: health.lastEmployerAtsSyncAt,
    lastSyncStatus: health.lastEmployerAtsSyncStatus,
    lastFreshSyncAt: health.lastFreshSyncAt,
    lastFreshSyncStatus: health.lastFreshSyncStatus,
    lastLiveDiscoveryAt: liveDiscovery.lastLiveDiscoveryAt,
    newJobsLastRun: health.lastEmployerAtsSyncNewJobs,
    updatedJobsLastRun: health.lastEmployerAtsSyncUpdatedJobs,
    activeCount: health.active,
    activeTarget: health.activeTarget,
    activeTargetReached: health.targetReached,
    fresh24hCount: health.fresh24h,
    fresh72hCount: health.fresh72h,
    fresh24hTarget: FRESH_24H_TARGET,
    fresh72hTarget: FRESH_72H_TARGET,
    freshnessTargetReached: health.fresh24h >= FRESH_24H_TARGET && health.fresh72h >= FRESH_72H_TARGET,
    latestSourcePostedAt: liveDiscovery.newestSourcePostedAt,
    sourceLagMinutesP50: liveDiscovery.sourceLagMinutesP50,
    sourceLagMinutesP95: liveDiscovery.sourceLagMinutesP95,
    recentLagSampleSize: liveDiscovery.recentLagSampleSize,
    liveQueue: liveDiscovery.queue,
    verifiedCount: health.verifiedActive,
    needsReviewCount: health.needsReviewCount,
    closedCount: health.closedCount,
    pendingCount: health.pendingCount,
    recentErrorCount: health.recentErrorCount,
    computedAt,
    cacheFresh: fresh,
  });
}
