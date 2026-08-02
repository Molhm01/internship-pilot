import { prisma } from "@/lib/db";

const PAUSE_KEY = "scheduler:paused";
const TICK_KEY_PREFIX = "scheduler:tick:";

export async function isSchedulerPaused(): Promise<boolean> {
  const setting = await prisma.appSetting.findUnique({ where: { key: PAUSE_KEY } });
  return setting?.value === "true";
}

export async function setSchedulerPaused(paused: boolean): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: PAUSE_KEY },
    update: { value: String(paused) },
    create: { key: PAUSE_KEY, value: String(paused) },
  });
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

export async function getSchedulerHealth(): Promise<{ paused: boolean; ticks: Record<string, TickInfo> }> {
  const paused = await isSchedulerPaused();
  const settings = await prisma.appSetting.findMany({
    where: { key: { startsWith: TICK_KEY_PREFIX } },
  });
  const ticks: Record<string, TickInfo> = {};
  for (const s of settings) {
    const name = s.key.slice(TICK_KEY_PREFIX.length);
    ticks[name] = JSON.parse(s.value) as TickInfo;
  }
  return { paused, ticks };
}
