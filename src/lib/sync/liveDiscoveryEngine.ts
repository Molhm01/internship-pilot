import { prisma } from "@/lib/db";
import { runCompanyDiscoveryBatch } from "@/lib/sync/companyDiscovery";
import { runLiveDirectRadar } from "@/lib/sync/liveDirectRadar";
import { pruneTerminalLiveDiscoveryEvents } from "@/lib/sync/liveDiscoveryMaintenance";
import {
  enqueueJobrightFreshSignals,
  processLiveDiscoveryQueue,
} from "@/lib/sync/liveDiscoveryQueue";
import {
  enqueueInternListPublicRadar,
  processSupplementalRadarQueue,
} from "@/lib/sync/supplementalRadarQueue";
import {
  getLiveDiscoveryQueueHealthFast,
  getSupplementalRadarHealthFast,
} from "@/lib/sync/radarQueueHealth";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// The timestamped Jobright/direct lanes are small deltas and stay on the
// 5-minute live cadence. The deep Intern List crawl is intentionally broader;
// running a 1,500-row crawl and a 10k-row queue scan every five minutes is both
// unnecessary and hostile to a serverless database. Keep high recall, but run
// the expensive catalogue lane on its own slower cadence.
const INTERN_LIST_DEEP_CRAWL_INTERVAL_MS = 30 * MINUTE_MS;
const SUPPLEMENTAL_DRAIN_INTERVAL_MS = 10 * MINUTE_MS;
const INTERN_LIST_CURSOR_KEY = "supplementalRadar:cursor:intern-list-public";
const SUPPLEMENTAL_DRAIN_CURSOR_KEY = "liveDiscovery:cursor:supplemental-drain";

function percentile(values: number[], pct: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * pct) - 1));
  return sorted[index] ?? null;
}

function parsedDateFromSetting(value: string | null | undefined, field: string): Date | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const raw = parsed[field];
    if (typeof raw !== "string") return null;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

async function deepInternListCrawlDue(now: Date): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: INTERN_LIST_CURSOR_KEY } });
  const lastCheckedAt = parsedDateFromSetting(row?.value, "lastCheckedAt");
  return !lastCheckedAt || now.getTime() - lastCheckedAt.getTime() >= INTERN_LIST_DEEP_CRAWL_INTERVAL_MS;
}

async function supplementalDrainDue(now: Date): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: SUPPLEMENTAL_DRAIN_CURSOR_KEY } });
  const lastRunAt = parsedDateFromSetting(row?.value, "lastRunAt");
  return !lastRunAt || now.getTime() - lastRunAt.getTime() >= SUPPLEMENTAL_DRAIN_INTERVAL_MS;
}

async function markSupplementalDrain(now: Date): Promise<void> {
  const value = JSON.stringify({ version: 1, lastRunAt: now.toISOString() });
  await prisma.appSetting.upsert({
    where: { key: SUPPLEMENTAL_DRAIN_CURSOR_KEY },
    create: { key: SUPPLEMENTAL_DRAIN_CURSOR_KEY, value },
    update: { value },
  });
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
    // Database-side aggregates return a handful of integers instead of pulling
    // 2k + 10k JSON queue records into every health/status invocation.
    getLiveDiscoveryQueueHealthFast(),
    getSupplementalRadarHealthFast(),
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
  const now = new Date();
  const atsCheckLimit = Math.max(1, Math.min(options.atsCheckLimit ?? 40, 100));
  const queueProcessLimit = Math.max(1, Math.min(options.queueProcessLimit ?? 80, 200));
  const directRadarLimit = Math.max(1, Math.min(options.directRadarLimit ?? 250, 500));
  const internListPages = Math.max(1, Math.min(options.internListPages ?? 12, 30));
  const internListJobs = Math.max(1, Math.min(options.internListJobs ?? 1_500, 3_000));

  const [crawlDue, drainDue] = await Promise.all([
    deepInternListCrawlDue(now),
    supplementalDrainDue(now),
  ]);

  // Fresh timestamped sources remain five-minute lanes. Deep Intern List keeps
  // the same 12-page/1,500-row recall target, just not five-minute repetition.
  const [enqueue, directRadar, internListRadar] = await Promise.all([
    enqueueJobrightFreshSignals(),
    runLiveDirectRadar(directRadarLimit),
    crawlDue
      ? enqueueInternListPublicRadar({
          maxPages: internListPages,
          maxJobs: internListJobs,
          concurrency: 6,
        })
      : Promise.resolve({
          skipped: "cadence" as const,
          sourceFetched: 0,
          pagesFetched: 0,
          pagesFailed: 0,
          maxPagesReached: false,
          maxJobsReached: false,
          considered: 0,
          enqueued: 0,
          alreadyQueued: 0,
        }),
  ]);

  const queue = await processLiveDiscoveryQueue(queueProcessLimit);
  const supplementalQueue = drainDue
    ? await processSupplementalRadarQueue(Math.min(200, Math.max(queueProcessLimit, 120)))
    : {
        skipped: "cadence" as const,
        due: 0,
        processed: 0,
        resolved: 0,
        retried: 0,
        abandoned: 0,
        newCount: 0,
        updatedCount: 0,
      };
  if (drainDue) await markSupplementalDrain(now);

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
