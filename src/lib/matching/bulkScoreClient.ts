import type {
  BulkInitialMatchScheduleResult,
  BulkInitialMatchStatus,
} from "@/lib/matching/bulkInitialMatch";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function safeMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object" || !("message" in body)) return fallback;
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isScheduleResult(value: unknown): value is BulkInitialMatchScheduleResult {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<BulkInitialMatchScheduleResult>;
  return body.ok === true
    && isCount(body.eligible)
    && isCount(body.queued)
    && isCount(body.skippedAlreadyScored)
    && isCount(body.skippedAlreadyQueued)
    && isCount(body.failedToQueue);
}

export async function requestScoreAllUnscored(
  fetcher: FetchLike = fetch,
): Promise<BulkInitialMatchScheduleResult> {
  const response = await fetcher("/api/jobs/score-unscored", { method: "POST" });
  let body: unknown;
  try {
    body = await response.json() as unknown;
  } catch {
    const detail = process.env.NODE_ENV === "development" ? ` HTTP ${response.status}.` : "";
    throw new Error(`The scoring API returned an invalid response.${detail}`);
  }
  if (!response.ok || !isScheduleResult(body)) {
    const fallback = process.env.NODE_ENV === "development"
      ? `Unscored jobs could not be queued (HTTP ${response.status}).`
      : "Unscored jobs could not be queued.";
    throw new Error(safeMessage(body, fallback));
  }
  return body;
}

export async function fetchBulkScoreStatus(
  fetcher: FetchLike = fetch,
): Promise<BulkInitialMatchStatus> {
  const response = await fetcher("/api/jobs/score-unscored/status", { cache: "no-store" });
  const body = await response.json() as { ok?: boolean; status?: BulkInitialMatchStatus; message?: unknown };
  if (!response.ok || body.ok !== true || !body.status) {
    throw new Error(safeMessage(body, "Scoring progress is temporarily unavailable."));
  }
  return body.status;
}

export async function runBulkScoreScheduling(options: {
  setScheduling: (value: boolean) => void;
  onSuccess: (result: BulkInitialMatchScheduleResult) => void | Promise<void>;
  onError: (message: string) => void;
  fetcher?: FetchLike;
}): Promise<void> {
  options.setScheduling(true);
  try {
    const result = await requestScoreAllUnscored(options.fetcher);
    await options.onSuccess(result);
  } catch (error) {
    options.onError(error instanceof Error ? error.message : "Unscored jobs could not be queued.");
  } finally {
    options.setScheduling(false);
  }
}

type VisibilitySource = {
  visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

export type BulkScoreStatusWatch = {
  /** Stops the watch entirely (component unmount). */
  stop: () => void;
  /**
   * Triggers one immediate status check outside the normal poll cycle.
   * This is the mechanism for every "meaningful event" the watch should
   * react to while idle — the caller decides what counts as one (a sync
   * completing, a job being added, an explicit user refresh, ...); the
   * watch itself only reacts automatically to the tab becoming visible.
   */
  recheck: () => Promise<void>;
};

/**
 * Watches bulk AI-match scoring progress with ZERO recurring database cost
 * while idle (database-usage repair, pass #5 — idle is IDLE, not "polling
 * slowly forever").
 *
 * Previous shapes (passes #1-#3) polled continuously even with nothing
 * queued or running, at cadences from 15s down to 2 minutes — each poll is
 * six `count()` queries against Prisma Postgres (see
 * src/app/api/jobs/score-unscored/status/route.ts). A tab left open all day
 * with nothing to score was paying for that discovery indefinitely.
 *
 * The new contract:
 *   ACTIVE (queued > 0 || running > 0): keep polling at `intervalMs` — a
 *     bounded, self-terminating cost that stops the moment the queue drains.
 *   IDLE: schedule NOTHING. Zero timers, zero future requests, until
 *     something calls `recheck()` — the tab becoming visible again is the
 *     one trigger this module wires up itself; every other "meaningful
 *     event" (a sync completing, an add-job submit, an explicit refresh
 *     action, navigating back to this page) is the CALLER's job to route
 *     into `recheck()`, since only the caller knows when those happen.
 */
export function startBulkScoreStatusPolling(options: {
  fetchStatus: () => Promise<BulkInitialMatchStatus>;
  onStatus: (status: BulkInitialMatchStatus) => void;
  onError?: (message: string) => void;
  intervalMs?: number;
  visibility?: VisibilitySource;
}): BulkScoreStatusWatch {
  const intervalMs = Math.max(5_000, options.intervalMs ?? 5_000);
  const visibility = options.visibility ?? document;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const tick = async () => {
    if (stopped || inFlight || visibility.visibilityState === "hidden") return;
    inFlight = true;
    try {
      const status = await options.fetchStatus();
      if (stopped) return;
      options.onStatus(status);
      const active = status.queued > 0 || status.running > 0;
      clearTimer();
      // IDLE schedules nothing — the whole point of this rewrite. ACTIVE
      // keeps polling until the queue drains on its own.
      if (active && !stopped && visibility.visibilityState !== "hidden") {
        timer = setTimeout(() => void tick(), intervalMs);
      }
    } catch (error) {
      if (!stopped) {
        options.onError?.(error instanceof Error ? error.message : "Scoring progress is unavailable.");
        // Treated the same as IDLE, not retried automatically: a transient
        // error must not turn into a permanent poll loop either. The same
        // recheck() triggers (visibility, caller-routed events) recover it.
        clearTimer();
      }
    } finally {
      inFlight = false;
    }
  };

  const onVisibilityChange = () => {
    if (!stopped && visibility.visibilityState !== "hidden") void tick();
  };

  visibility.addEventListener("visibilitychange", onVisibilityChange);
  void tick();

  return {
    stop: () => {
      stopped = true;
      clearTimer();
      visibility.removeEventListener("visibilitychange", onVisibilityChange);
    },
    recheck: () => tick(),
  };
}
