import { prisma } from "@/lib/db";

/**
 * Hosted ingestion lanes.
 *
 * One daily route that did everything could not be run more often: it sweeps
 * the whole employer registry, refreshes descriptions and reverifies the
 * catalogue, and none of that fits in a five-minute cadence. But "a new
 * internship should appear within minutes" is the product, so the work is
 * split by how urgent it is rather than run all at once:
 *
 *   fresh       — newly posted opportunities only, strict time budget
 *   standard    — the ordinary polling and verification cycle
 *   maintenance — the deep, expensive, slow-changing work
 *
 * Every lane authenticates with CRON_SECRET, takes an exclusive lease so two
 * invocations can never overlap, and never touches Ollama, ATS scoring, or a
 * browser. Discovery queues scoring; it does not perform it.
 */

export const CRON_LANES = ["fresh", "standard", "maintenance"] as const;
export type CronLane = (typeof CRON_LANES)[number];

export function isAuthorizedCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization");
  if (!header) return false;

  // Constant-time-ish comparison: length first, then a full-width compare that
  // does not exit early on the first differing character.
  const expected = `Bearer ${secret}`;
  if (header.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= header.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

export function unauthorizedCronResponse(): Response {
  return Response.json(
    { error: "Unauthorized cron request." },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

export type LeaseRecord = { holder: string; acquiredAt: string; expiresAt: string };

export function leaseKey(lane: CronLane): string {
  return `cron:lease:job-ingestion:${lane}`;
}

/** Pure: may a new holder take this lease? */
export function leaseIsAvailable(existing: LeaseRecord | null, now: Date): boolean {
  if (!existing) return true;
  const expiresAt = Date.parse(existing.expiresAt);
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt <= now.getTime();
}

export function parseLease(value: string | null | undefined): LeaseRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<LeaseRecord>;
    if (typeof parsed?.holder !== "string" || typeof parsed?.expiresAt !== "string") return null;
    return { holder: parsed.holder, acquiredAt: parsed.acquiredAt ?? parsed.expiresAt, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export type LeaseOutcome =
  | { acquired: true; holder: string }
  | { acquired: false; heldBy: string; expiresAt: string };

/**
 * Takes an exclusive lease on a lane.
 *
 * `AppSetting.key` is the primary key, so `create` is the atomic primitive: at
 * most one caller can win it. Reclaiming an expired lease is a compare-and-set
 * on the exact previous value, so two invocations racing to reclaim the same
 * dead lease cannot both succeed. Both matter here — Vercel will happily start
 * a second invocation of a five-minute cron while the first is still running.
 */
export async function acquireLane(
  lane: CronLane,
  ttlMs: number,
  now = new Date(),
  holder = `${lane}-${now.toISOString()}-${Math.random().toString(36).slice(2, 8)}`,
): Promise<LeaseOutcome> {
  const key = leaseKey(lane);
  const record: LeaseRecord = {
    holder,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  const value = JSON.stringify(record);

  try {
    await prisma.appSetting.create({ data: { key, value } });
    return { acquired: true, holder };
  } catch {
    // Row exists: only an expired lease may be reclaimed.
  }

  const current = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
  const existing = parseLease(current?.value);
  if (!leaseIsAvailable(existing, now)) {
    return {
      acquired: false,
      heldBy: existing?.holder ?? "unknown",
      expiresAt: existing?.expiresAt ?? "unknown",
    };
  }

  const claimed = await prisma.appSetting.updateMany({
    where: { key, value: current?.value ?? "" },
    data: { value },
  });
  if (claimed.count === 1) return { acquired: true, holder };

  return { acquired: false, heldBy: existing?.holder ?? "unknown", expiresAt: existing?.expiresAt ?? "unknown" };
}

/** Releases a lease, but only if this holder still owns it. */
export async function releaseLane(lane: CronLane, holder: string): Promise<void> {
  const key = leaseKey(lane);
  const current = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
  const existing = parseLease(current?.value);
  if (!existing || existing.holder !== holder) return;
  await prisma.appSetting.deleteMany({ where: { key, value: current?.value ?? "" } });
}

// ---------------------------------------------------------------------------
// Time budgeting
// ---------------------------------------------------------------------------

/**
 * A lane must finish well inside its cadence, not merely inside the platform's
 * function timeout: a fresh lane that runs for six minutes on a five-minute
 * schedule permanently overlaps itself.
 */
export class LaneBudget {
  private readonly startedAt: number;

  constructor(private readonly totalMs: number, startedAt = Date.now()) {
    this.startedAt = startedAt;
  }

  elapsedMs(now = Date.now()): number {
    return now - this.startedAt;
  }

  remainingMs(now = Date.now()): number {
    return Math.max(0, this.totalMs - this.elapsedMs(now));
  }

  /** True while at least `needMs` of budget remains for the next step. */
  canAfford(needMs: number, now = Date.now()): boolean {
    return this.remainingMs(now) >= needMs;
  }
}

export type LaneStepResult<T> = { ran: boolean; skipped?: "budget_exhausted"; value: T | null; ms: number };

/** Runs a step only if the budget allows, and never lets one step fail a lane. */
export async function runLaneStep<T>(
  budget: LaneBudget,
  needMs: number,
  step: () => Promise<T>,
): Promise<LaneStepResult<T> & { error?: string }> {
  if (!budget.canAfford(needMs)) return { ran: false, skipped: "budget_exhausted", value: null, ms: 0 };
  const startedAt = Date.now();
  try {
    const value = await step();
    return { ran: true, value, ms: Date.now() - startedAt };
  } catch (error) {
    return {
      ran: true,
      value: null,
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    };
  }
}

export function boundedEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, value));
}
