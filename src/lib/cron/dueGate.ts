import { prisma } from "@/lib/db";

/**
 * Per-source "is this actually due" gate for recurring cron steps.
 *
 * Pass #1 of the database-usage repair made the fresh lane cheap when there
 * is nothing to resolve, but the standard lane still ran every one of its
 * five steps — public-direct-feed scan, Intern List scan, description
 * hydration, freshness verification — on every hourly tick, regardless of
 * whether that specific source had anything new to offer since the last
 * time it actually ran. Those steps read a static external feed or scan a
 * meaningful slice of the job table even when nothing has changed.
 *
 * This module lets each step declare its OWN cadence (independent of the
 * lane's cadence) and skip entirely — no network fetch, no Prisma call
 * beyond the one shared batch check below — when it isn't due yet.
 *
 * `checkDue` is intentionally a single batched query for every step passed
 * to it, rather than one query per step: a standard-lane tick with three
 * gated steps costs one `findMany` here, not three.
 */

const KEY_PREFIX = "cron:due:";

function settingKey(name: string): string {
  return `${KEY_PREFIX}${name}`;
}

export type DueSpec = { name: string; intervalMs: number };

/**
 * Returns, for every named step, whether at least `intervalMs` has elapsed
 * since it last actually ran (recorded via `markRan`). A step that has never
 * run is due immediately. One query total, regardless of how many steps are
 * checked.
 */
export async function checkDue(
  steps: readonly DueSpec[],
  now: Date = new Date(),
): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  if (steps.length === 0) return result;

  const rows = await prisma.appSetting.findMany({
    where: { key: { in: steps.map((step) => settingKey(step.name)) } },
    select: { key: true, value: true },
  });
  const lastRunByKey = new Map(rows.map((row) => [row.key, row.value]));

  for (const step of steps) {
    const raw = lastRunByKey.get(settingKey(step.name));
    const lastRunAt = raw ? Date.parse(raw) : Number.NaN;
    result[step.name] = !Number.isFinite(lastRunAt) || now.getTime() - lastRunAt >= step.intervalMs;
  }
  return result;
}

/** Records that a step actually ran, so the next `checkDue` honors its interval. */
export async function markRan(name: string, now: Date = new Date()): Promise<void> {
  const key = settingKey(name);
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: now.toISOString() },
    update: { value: now.toISOString() },
  });
}

/** Uniform "skipped, not due yet" shape matching runLaneStep's step-result shape. */
export function notDueStep<T>(): { ran: false; skipped: "not_due"; value: T | null; ms: number } {
  return { ran: false, skipped: "not_due", value: null, ms: 0 };
}
