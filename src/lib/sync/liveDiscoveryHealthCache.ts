import { prisma } from "@/lib/db";
import { getLiveDiscoveryHealth } from "@/lib/sync/liveDiscoveryEngine";

/**
 * One shared, cached computation of catalog/live-discovery health.
 *
 * Before this cache existed, `/api/health/catalog`, `/api/sync/status`, and
 * every open browser tab's `SyncStatusPanel` (polling every 60s) each
 * independently ran ~20 Prisma queries — several counts, a `groupBy`, a
 * 250-row `findMany` for source-lag percentiles, and `getLiveDiscoveryHealth()`
 * itself. That duplication was the second-largest driver of the Prisma
 * Postgres Free-plan overage documented in the DATABASE USAGE DIAGNOSTIC.
 *
 * This module computes the full shared aggregate ONCE and caches it in two
 * layers:
 *   1. An in-process memory cache — free, but only shared within one warm
 *      serverless instance.
 *   2. A database-backed cache row (`AppSetting`) — one cheap query, shared
 *      across every instance and every browser tab, so a burst of concurrent
 *      requests across the whole deployment collapses into a single full
 *      computation per TTL window instead of one computation per caller.
 *
 * A 90s TTL keeps data close to real-time relative to the slowest consumer
 * (a 5-minute client refresh, a 10-minute cron lane) while collapsing bursts.
 * Failures are never cached — a broken computation surfaces on the very next
 * call rather than being hidden behind a stale "healthy" TTL.
 */

const CACHE_KEY = "catalogHealth:cache:v1";
const TTL_MS = 90_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_TARGET = 500;

export type LiveDiscoveryHealth = Awaited<ReturnType<typeof getLiveDiscoveryHealth>>;

export type CatalogHealth = {
  activeTarget: number;
  active: number;
  targetReached: boolean;
  verifiedActive: number;
  total: number;
  fresh24h: number;
  fresh72h: number;
  olderThan14d: number;
  needsReviewCount: number;
  closedCount: number;
  pendingCount: number;
  recentErrorCount: number;
  /** Most recent employer-ATS sync log regardless of outcome (success or error). */
  lastEmployerAtsSyncAt: string | null;
  lastEmployerAtsSyncStatus: string | null;
  lastEmployerAtsSyncNewJobs: number;
  lastEmployerAtsSyncUpdatedJobs: number;
  /** Most recent SUCCESSFUL employer-ATS sync only (catalog health's "last successful sync"). */
  lastSuccessfulEmployerAtsSyncAt: string | null;
  lastSuccessfulEmployerAtsSyncNewJobs: number;
  lastSuccessfulEmployerAtsSyncUpdatedJobs: number;
  lastFreshSyncAt: string | null;
  lastFreshSyncStatus: string | null;
  activeBySource: Array<{ source: string | null; count: number }>;
  liveDiscovery: LiveDiscoveryHealth;
};

type CacheEnvelope = {
  computedAt: string;
  value: CatalogHealth;
};

let memoryCache: CacheEnvelope | null = null;
// Collapses concurrent callers within one instance into a single computation
// instead of each one racing to recompute and re-write the DB cache row.
let inFlight: Promise<{ health: CatalogHealth; computedAt: string; fresh: boolean }> | null = null;

function isFresh(computedAt: string, now: number): boolean {
  const at = Date.parse(computedAt);
  return Number.isFinite(at) && now - at < TTL_MS;
}

async function readDbCache(): Promise<CacheEnvelope | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: CACHE_KEY } });
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as CacheEnvelope;
  } catch {
    return null;
  }
}

async function writeDbCache(envelope: CacheEnvelope): Promise<void> {
  await prisma.appSetting
    .upsert({
      where: { key: CACHE_KEY },
      update: { value: JSON.stringify(envelope) },
      create: { key: CACHE_KEY, value: JSON.stringify(envelope) },
    })
    .catch(() => undefined);
}

async function computeCatalogHealth(): Promise<CatalogHealth> {
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
    needsReviewCount,
    closedCount,
    pendingCount,
    latestEmployerAtsSyncAny,
    latestSuccessfulEmployerAtsSync,
    latestFreshSync,
    recentErrorCount,
    bySource,
    liveDiscovery,
  ] = await Promise.all([
    prisma.job.count({ where: { activeFeed: true } }),
    prisma.job.count(),
    prisma.job.count({
      where: { activeFeed: true, verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK" },
    }),
    prisma.job.count({ where: { activeFeed: true, sourcePostedAt: { gte: last24h } } }),
    prisma.job.count({ where: { activeFeed: true, sourcePostedAt: { gte: last72h } } }),
    prisma.job.count({ where: { activeFeed: true, sourcePostedAt: { lt: fourteenDaysAgo } } }),
    prisma.job.count({ where: { activeFeed: false, verificationStatus: "NeedsReview" } }),
    prisma.job.count({ where: { verificationStatus: "Closed" } }),
    prisma.job.count({ where: { activeFeed: false, verificationStatus: "Pending" } }),
    prisma.syncLog.findFirst({
      where: { source: "employer-ats", status: { in: ["success", "error"] } },
      orderBy: { startedAt: "desc" },
      select: { finishedAt: true, status: true, newJobsCount: true, updatedJobsCount: true },
    }),
    prisma.syncLog.findFirst({
      where: { source: "employer-ats", status: "success" },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true, newJobsCount: true, updatedJobsCount: true },
    }),
    prisma.syncLog.findFirst({
      where: { source: { in: ["live-discovery", "fresh-discovery"] }, status: { in: ["success", "error"] } },
      orderBy: { startedAt: "desc" },
      select: { finishedAt: true, status: true },
    }),
    prisma.syncLog.count({
      where: {
        source: { in: ["employer-ats", "live-discovery", "fresh-discovery"] },
        status: "error",
        startedAt: { gt: last24h },
      },
    }),
    prisma.job.groupBy({
      by: ["source"],
      where: { activeFeed: true },
      _count: { _all: true },
      orderBy: { _count: { source: "desc" } },
    }),
    getLiveDiscoveryHealth(),
  ]);

  return {
    activeTarget: ACTIVE_TARGET,
    active,
    targetReached: active >= ACTIVE_TARGET,
    verifiedActive,
    total,
    fresh24h,
    fresh72h,
    olderThan14d,
    needsReviewCount,
    closedCount,
    pendingCount,
    recentErrorCount,
    lastEmployerAtsSyncAt: latestEmployerAtsSyncAny?.finishedAt?.toISOString() ?? null,
    lastEmployerAtsSyncStatus: latestEmployerAtsSyncAny?.status ?? null,
    lastEmployerAtsSyncNewJobs: latestEmployerAtsSyncAny?.newJobsCount ?? 0,
    lastEmployerAtsSyncUpdatedJobs: latestEmployerAtsSyncAny?.updatedJobsCount ?? 0,
    lastSuccessfulEmployerAtsSyncAt: latestSuccessfulEmployerAtsSync?.finishedAt?.toISOString() ?? null,
    lastSuccessfulEmployerAtsSyncNewJobs: latestSuccessfulEmployerAtsSync?.newJobsCount ?? 0,
    lastSuccessfulEmployerAtsSyncUpdatedJobs: latestSuccessfulEmployerAtsSync?.updatedJobsCount ?? 0,
    lastFreshSyncAt: latestFreshSync?.finishedAt?.toISOString() ?? null,
    lastFreshSyncStatus: latestFreshSync?.status ?? null,
    activeBySource: bySource.map((row) => ({ source: row.source, count: row._count._all })),
    liveDiscovery,
  };
}

async function computeAndCache(): Promise<{ health: CatalogHealth; computedAt: string; fresh: boolean }> {
  const health = await computeCatalogHealth();
  const computedAt = new Date().toISOString();
  const envelope: CacheEnvelope = { computedAt, value: health };
  memoryCache = envelope;
  await writeDbCache(envelope);
  return { health, computedAt, fresh: true };
}

/**
 * Returns cached catalog/live-discovery health, computing it (and sharing
 * that computation with every other caller across the deployment) only when
 * the cache is missing or older than the TTL.
 *
 * `force: true` bypasses both cache layers — used by callers that must prove
 * a live value right now (e.g. a manual "Run sync" action) rather than
 * display a TTL-stale one.
 */
export async function getCachedCatalogHealth(
  options: { force?: boolean } = {},
): Promise<{ health: CatalogHealth; computedAt: string; fresh: boolean }> {
  const now = Date.now();

  if (!options.force) {
    if (memoryCache && isFresh(memoryCache.computedAt, now)) {
      return { health: memoryCache.value, computedAt: memoryCache.computedAt, fresh: false };
    }
    if (inFlight) return inFlight;

    const dbCache = await readDbCache();
    if (dbCache && isFresh(dbCache.computedAt, now)) {
      memoryCache = dbCache;
      return { health: dbCache.value, computedAt: dbCache.computedAt, fresh: false };
    }
  }

  if (inFlight) return inFlight;
  inFlight = computeAndCache().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
