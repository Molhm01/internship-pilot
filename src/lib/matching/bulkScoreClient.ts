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

export function startBulkScoreStatusPolling(options: {
  fetchStatus: () => Promise<BulkInitialMatchStatus>;
  onStatus: (status: BulkInitialMatchStatus) => void;
  onError?: (message: string) => void;
  intervalMs?: number;
  visibility?: VisibilitySource;
}): () => void {
  const intervalMs = Math.max(5_000, options.intervalMs ?? 5_000);
  const visibility = options.visibility ?? document;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const scheduleNext = () => {
    clearTimer();
    if (!stopped && visibility.visibilityState !== "hidden") {
      timer = setTimeout(() => void tick(), intervalMs);
    }
  };

  const tick = async () => {
    if (stopped || inFlight || visibility.visibilityState === "hidden") return;
    inFlight = true;
    try {
      const status = await options.fetchStatus();
      if (stopped) return;
      options.onStatus(status);
      if (status.queued > 0 || status.running > 0) scheduleNext();
    } catch (error) {
      if (!stopped) {
        options.onError?.(error instanceof Error ? error.message : "Scoring progress is unavailable.");
        scheduleNext();
      }
    } finally {
      inFlight = false;
    }
  };

  const onVisibilityChange = () => {
    clearTimer();
    if (!stopped && visibility.visibilityState !== "hidden") void tick();
  };

  visibility.addEventListener("visibilitychange", onVisibilityChange);
  scheduleNext();
  return () => {
    stopped = true;
    clearTimer();
    visibility.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
