import { prisma } from "@/lib/db";
import { runCompanyDiscoveryBatch } from "@/lib/sync/companyDiscovery";
import { runLiveDirectRadar } from "@/lib/sync/liveDirectRadar";
import { pruneTerminalLiveDiscoveryEvents } from "@/lib/sync/liveDiscoveryMaintenance";
import {
  enqueueJobrightFreshSignals,
  getLiveDiscoveryQueueHealth,
  processLiveDiscoveryQueue,
} from "@/lib/sync/liveDiscoveryQueue";
import {
  enqueueInternListPublicRadar,
  getSupplementalRadarHealth,
  processSupplementalRadarQueue,
} from "@/lib/sync/supplementalRadarQueue";

const DAY_MS = 24 * 60 * 60 * 1000;

function percentile(values: number[], pct: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * pct) - 1));
  return sorted[index] ?? null;
}

export async function getLiveDiscoveryHealth() {
  const now = Date.now();
  const [
    active,
    fresh24h,
    fresh72h,
    newest,
    recentJobs,
    queue,
    supplementalRadar,
    lastLiveRun,
    lastLiveError,
    directRadarCursor,
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
      select: { sourcePostedAt: true, firstSeenAt: true, title: true, company: true },
    }),
    prisma.job.findMany({
      where: {
        activeFeed: true,
        sourcePostedAt: { gte: new Date(now - 3 * DAY_MS) },
        firstSeenAt: { not: null },
      },
      orderBy: { sourcePostedAt: "desc" },
      take: 250,
      select: { sourcePostedAt: true, firstSeenAt: true },
    }),
    getLiveDiscoveryQueueHealth(),
    getSupplementalRadarHealth(),
    prisma.syncLog.findFirst({
      where: { source: "live-discovery", status: "success" },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true, newJobsCount: true, updatedJobsCount: true },
    }),
    prisma.syncLog.findFirst({
      where: { source: "live-discovery", status: "error" },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true, errorMessage: true },
    }),
    prisma.appSetting.findUnique({ where: { key: "liveDiscovery:cursor:direct-radar" } }),
  ]);

  const lagsMinutes = recentJobs
    .map((job) => {
      if (!job.sourcePostedAt || !job.firstSeenAt) return null;
      return Math.max(0, (job.firstSeenAt.getTime() - job.sourcePostedAt.getTime()) / 60_000);
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));

  let directRadar: unknown = null;
  try {
    directRadar = directRadarCursor?.value ? JSON.parse(directRadarCursor.value) : null;
  } catch {
    directRadar = null;
  }

  return {
    active,
    fresh24h,
    fresh72h,
    newestSourcePostedAt: newest?.sourcePostedAt?.toISOString() ?? null,
    newestFirstSeenAt: newest?.firstSeenAt?.toISOString() ?? null,
    newestTitle: newest?.title ?? null,
    newestCompany: newest?.company ?? null,
    sourceLagMinutesP50: percentile(lagsMinutes, 0.5),
    sourceLagMinutesP95: percentile(lagsMinutes, 0.95),
    recentLagSampleSize: lagsMinutes.length,
    queue,
    supplementalRadar,
    directRadar,
    lastLiveDiscoveryAt: lastLiveRun?.finishedAt?.toISOString() ?? null,
    lastLiveNewJobs: lastLiveRun?.newJobsCount ?? 0,
    lastLiveUpdatedJobs: lastLiveRun?.updatedJobsCount ?? 0,
    lastLiveErrorAt: lastLiveError?.finishedAt?.toISOString() ?? null,
    lastLiveError: lastLiveError?.errorMessage ?? null,
  };
}

export async function runLiveDiscoveryCycle(options: {
  atsCheckLimit?: number;
  queueProcessLimit?: number;
  directRadarLimit?: number;
  internListPages?: number;
  internListJobs?: number;
} = {}) {
  const startedAt = Date.now();
  const atsCheckLimit = Math.max(1, Math.min(options.atsCheckLimit ?? 40, 100));
  const queueProcessLimit = Math.max(1, Math.min(options.queueProcessLimit ?? 80, 200));
  const directRadarLimit = Math.max(1, Math.min(options.directRadarLimit ?? 250, 500));
  const internListPages = Math.max(1, Math.min(options.internListPages ?? 12, 30));
  const internListJobs = Math.max(1, Math.min(options.internListJobs ?? 1_500, 3_000));

  // Three independent radar lanes run in parallel:
  // 1) Jobright's freshest timestamped technical minisites,
  // 2) public indexes that already expose official URLs,
  // 3) a much deeper crawl of Intern List's public technical collection.
  // None of the aggregator lanes is trusted as the final destination; queued
  // signals must resolve to an employer ATS before entering Discover.
  const [enqueue, directRadar, internListRadar] = await Promise.all([
    enqueueJobrightFreshSignals(),
    runLiveDirectRadar(directRadarLimit),
    enqueueInternListPublicRadar({
      maxPages: internListPages,
      maxJobs: internListJobs,
      concurrency: 6,
    }),
  ]);

  const [queue, supplementalQueue] = await Promise.all([
    processLiveDiscoveryQueue(queueProcessLimit),
    processSupplementalRadarQueue(queueProcessLimit),
  ]);
  const ats = await runCompanyDiscoveryBatch(atsCheckLimit);
  const prunedTerminalEvents = await pruneTerminalLiveDiscoveryEvents();

  const atsNew = ats.results.reduce((sum, row) => sum + row.newCount, 0);
  const atsUpdated = ats.results.reduce((sum, row) => sum + row.updatedCount, 0);
  const health = await getLiveDiscoveryHealth();
  return {
    ok: true,
    durationMs: Date.now() - startedAt,
    enqueue,
    internListRadar,
    directRadar,
    queue,
    supplementalQueue,
    prunedTerminalEvents,
    ats: {
      checked: ats.checked,
      newCount: atsNew,
      updatedCount: atsUpdated,
      errors: ats.results.filter((row) => row.status === "error").length,
      unsupported: ats.results.filter((row) => row.status === "unsupported").length,
    },
    newJobs:
      directRadar.newCount + queue.newCount + supplementalQueue.newCount + atsNew,
    updatedJobs:
      directRadar.updatedCount + queue.updatedCount + supplementalQueue.updatedCount + atsUpdated,
    health,
  };
}