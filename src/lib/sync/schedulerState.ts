import { prisma } from "@/lib/db";

const PAUSE_KEY = "scheduler:paused";
const PAUSE_METADATA_KEY = "scheduler:pause:metadata";
const HEARTBEAT_KEY = "scheduler:worker:heartbeat";
const TICK_KEY_PREFIX = "scheduler:tick:";

export type SchedulerPauseMetadata = {
  paused: boolean;
  source: string;
  reason: string;
  changedAt: string;
  expiresAt: string | null;
};

export type SchedulerHeartbeat = {
  startedAt: string;
  lastSeenAt: string;
  pid: number;
  runtime: string;
};

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function pauseIsActive(
  storedValue: string | null | undefined,
  metadata: SchedulerPauseMetadata | null,
  now = new Date(),
): boolean {
  if (storedValue !== "true") return false;
  if (!metadata?.expiresAt) return true;
  const expiresAt = Date.parse(metadata.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt > now.getTime();
}

export function heartbeatIsHealthy(
  heartbeat: SchedulerHeartbeat | null,
  now = new Date(),
  staleAfterMs = 45_000,
): boolean {
  if (!heartbeat) return false;
  const lastSeenAt = Date.parse(heartbeat.lastSeenAt);
  return Number.isFinite(lastSeenAt) && now.getTime() - lastSeenAt <= staleAfterMs;
}

export async function getSchedulerPauseState(): Promise<{
  paused: boolean;
  metadata: SchedulerPauseMetadata | null;
}> {
  // Keep these sequential: pause checks sit on every lane entry and do not
  // benefit from occupying two of the local stack's deliberately small pool.
  const setting = await prisma.appSetting.findUnique({ where: { key: PAUSE_KEY } });
  const metadataSetting = await prisma.appSetting.findUnique({ where: { key: PAUSE_METADATA_KEY } });
  const metadata = parseJson<SchedulerPauseMetadata>(metadataSetting?.value);
  return { paused: pauseIsActive(setting?.value, metadata), metadata };
}

export async function isSchedulerPaused(): Promise<boolean> {
  const state = await getSchedulerPauseState();
  if (!state.paused && state.metadata?.expiresAt && state.metadata.paused) {
    await setSchedulerPaused(false, {
      source: "scheduler",
      reason: "temporary_pause_expired",
    });
  }
  return state.paused;
}

export async function setSchedulerPaused(
  paused: boolean,
  context: { source?: string; reason?: string; expiresAt?: Date | null } = {},
): Promise<void> {
  const metadata: SchedulerPauseMetadata = {
    paused,
    source: context.source ?? "unknown",
    reason: context.reason ?? (paused ? "unspecified_pause" : "unspecified_resume"),
    changedAt: new Date().toISOString(),
    expiresAt: context.expiresAt?.toISOString() ?? null,
  };
  await prisma.$transaction(async (tx) => {
    await tx.appSetting.upsert({
      where: { key: PAUSE_KEY },
      update: { value: String(paused) },
      create: { key: PAUSE_KEY, value: String(paused) },
    });
    await tx.appSetting.upsert({
      where: { key: PAUSE_METADATA_KEY },
      update: { value: JSON.stringify(metadata) },
      create: { key: PAUSE_METADATA_KEY, value: JSON.stringify(metadata) },
    });
  });
}

export async function recordSchedulerHeartbeat(startedAt: string): Promise<void> {
  const heartbeat: SchedulerHeartbeat = {
    startedAt,
    lastSeenAt: new Date().toISOString(),
    pid: process.pid,
    runtime: process.env.INTERNSHIP_PILOT_RUNTIME ?? "unknown",
  };
  await prisma.appSetting.upsert({
    where: { key: HEARTBEAT_KEY },
    update: { value: JSON.stringify(heartbeat) },
    create: { key: HEARTBEAT_KEY, value: JSON.stringify(heartbeat) },
  });
}

export const DISCOVERY_QUALITY_COHORT_KEY = "discoveryQuality:cohortStartedAt";

/** Preserve the first instrumentation instant; restarts must not reset SLO data. */
export async function ensureDiscoveryQualityCohortStarted(at: Date = new Date()): Promise<Date> {
  const existing = await prisma.appSetting.findUnique({ where: { key: DISCOVERY_QUALITY_COHORT_KEY } });
  if (existing) return new Date(JSON.parse(existing.value) as string);
  try {
    await prisma.appSetting.create({
      data: { key: DISCOVERY_QUALITY_COHORT_KEY, value: JSON.stringify(at.toISOString()) },
    });
    return at;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) throw error;
    const raced = await prisma.appSetting.findUniqueOrThrow({ where: { key: DISCOVERY_QUALITY_COHORT_KEY } });
    return new Date(JSON.parse(raced.value) as string);
  }
}

export type TickInfo = {
  label: string;
  intervalMs: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: "success" | "error" | null;
  lastSummary: string | null;
  newJobsTotal: number;
  errorsTotal: number;
};

// Each schedule gets its OWN AppSetting row (key = "scheduler:tick:<name>")
// rather than all 5 sharing one JSON blob. Multiple independent setInterval
// callbacks update these concurrently; sharing one row meant a classic
// read-modify-write race — two ticks reading the same snapshot and each
// writing back a version missing the other's update, silently losing data.
// Per-schedule rows make every write independent, so there's nothing to race.
function tickKey(name: string): string {
  return `${TICK_KEY_PREFIX}${name}`;
}

async function getTick(name: string): Promise<TickInfo | null> {
  const setting = await prisma.appSetting.findUnique({ where: { key: tickKey(name) } });
  return setting ? (JSON.parse(setting.value) as TickInfo) : null;
}

async function saveTick(name: string, tick: TickInfo): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: tickKey(name) },
    update: { value: JSON.stringify(tick) },
    create: { key: tickKey(name), value: JSON.stringify(tick) },
  });
}

// Called by the scheduler right before running a scheduled task, so "next
// scheduled run" is always accurate even across restarts.
export async function scheduleNextTick(name: string, label: string, intervalMs: number): Promise<void> {
  const existing = await getTick(name);
  await saveTick(name, {
    label,
    intervalMs,
    lastRunAt: existing?.lastRunAt ?? null,
    nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
    lastStatus: existing?.lastStatus ?? null,
    lastSummary: existing?.lastSummary ?? null,
    newJobsTotal: existing?.newJobsTotal ?? 0,
    errorsTotal: existing?.errorsTotal ?? 0,
  });
}

export async function recordTickResult(
  name: string,
  result: { status: "success" | "error"; summary: string; newJobs?: number; errors?: number },
): Promise<void> {
  const existing = await getTick(name);
  if (!existing) return;
  await saveTick(name, {
    ...existing,
    lastRunAt: new Date().toISOString(),
    lastStatus: result.status,
    lastSummary: result.summary,
    newJobsTotal: existing.newJobsTotal + (result.newJobs ?? 0),
    errorsTotal: existing.errorsTotal + (result.errors ?? 0),
  });
}

type SchedulerHealth = {
  paused: boolean;
  pause: SchedulerPauseMetadata | null;
  worker: (SchedulerHeartbeat & { healthy: boolean }) | null;
  ticks: Record<string, TickInfo>;
};

async function computeSchedulerHealth(): Promise<SchedulerHealth> {
  const pauseState = await getSchedulerPauseState();
  const settings = await prisma.appSetting.findMany({
    where: { OR: [{ key: { startsWith: TICK_KEY_PREFIX } }, { key: HEARTBEAT_KEY }] },
  });
  const ticks: Record<string, TickInfo> = {};
  let heartbeat: SchedulerHeartbeat | null = null;
  for (const s of settings) {
    if (s.key === HEARTBEAT_KEY) {
      heartbeat = parseJson<SchedulerHeartbeat>(s.value);
      continue;
    }
    const name = s.key.slice(TICK_KEY_PREFIX.length);
    ticks[name] = JSON.parse(s.value) as TickInfo;
  }
  return {
    paused: pauseState.paused,
    pause: pauseState.metadata,
    worker: heartbeat ? { ...heartbeat, healthy: heartbeatIsHealthy(heartbeat) } : null,
    ticks,
  };
}

export async function getSchedulerHealth(): Promise<SchedulerHealth> {
  return computeSchedulerHealth();
}

// In-process cache only (no DB-backed layer): scheduler health is read by a
// single admin-facing panel, not fanned out across every browser tab like
// catalog health, so a short in-instance TTL is enough to collapse a burst of
// requests without adding another cross-instance cache row to maintain.
const SCHEDULER_HEALTH_TTL_MS = 20_000;
let cachedSchedulerHealth: { computedAt: number; value: SchedulerHealth } | null = null;
let schedulerHealthInFlight: Promise<SchedulerHealth> | null = null;

/**
 * Cached scheduler health for the `/api/scheduler/status` panel.
 *
 * Before this cache, every 30-second poll from `SchedulerHealthPanel` (per
 * open browser tab) recomputed this from three Prisma queries. The panel now
 * polls far less often and only while visible, but the cache stays as a
 * second line of defense against any caller that polls tighter than that.
 */
export async function getCachedSchedulerHealth(
  options: { force?: boolean } = {},
): Promise<{ health: SchedulerHealth; computedAt: string }> {
  const now = Date.now();
  if (!options.force && cachedSchedulerHealth && now - cachedSchedulerHealth.computedAt < SCHEDULER_HEALTH_TTL_MS) {
    return { health: cachedSchedulerHealth.value, computedAt: new Date(cachedSchedulerHealth.computedAt).toISOString() };
  }
  if (schedulerHealthInFlight) {
    const value = await schedulerHealthInFlight;
    return { health: value, computedAt: new Date(cachedSchedulerHealth?.computedAt ?? now).toISOString() };
  }
  schedulerHealthInFlight = computeSchedulerHealth().finally(() => {
    schedulerHealthInFlight = null;
  });
  const value = await schedulerHealthInFlight;
  cachedSchedulerHealth = { computedAt: now, value };
  return { health: value, computedAt: new Date(now).toISOString() };
}
