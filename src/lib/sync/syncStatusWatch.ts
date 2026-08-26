export type VisibilitySource = {
  visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

export type SyncStatusWatch = {
  /** Stops the watch entirely (component unmount). */
  stop: () => void;
  /**
   * Triggers one immediate check outside the automatic schedule — the
   * mechanism for every "meaningful event" this watch should react to
   * while idle (a manual "Run sync now", a mutation completing, an
   * automatic catchup finishing, ...). The caller decides what counts;
   * this module only reacts automatically to the tab becoming visible.
   */
  recheck: () => Promise<void>;
};

/**
 * Watches sync/discovery status with NO recurring timer while the tab sits
 * continuously visible and idle (database-usage repair, pass #6).
 *
 * Passes #1/#2 gave SyncStatusPanel a fixed 5-minute `setInterval` while
 * visible — a real improvement over the original 60-second poll, but still
 * a periodic cost paid forever just because the tab was open. Pass #5
 * measured the shared catalog-health computation this panel calls at 27
 * Prisma operations cold and 0 warm — and because the 5-minute poll
 * interval matched the cache's own 5-minute TTL almost exactly, most polls
 * from a single tab landed just outside the TTL window and paid the full
 * cold cost again. Over an 8-hour idle session that is roughly 96 polls x
 * up to 27 operations each — the gap pass #5 flagged as unmeasured and
 * pass #6 exists to close.
 *
 * New contract, mirroring src/lib/matching/bulkScoreClient.ts's pass #5
 * redesign:
 *   - One check on mount, if the tab starts visible.
 *   - The tab transitioning to visible triggers ONE check, but only if the
 *     last check is older than `staleAfterMs` — a brief tab switch does not
 *     re-trigger a database round trip.
 *   - NO recurring timer while continuously visible with nothing else
 *     happening. Zero scheduled work, zero future requests, until
 *     `recheck()` is called or the tab is hidden and shown again.
 *   - `recheck()` is the caller's hook for every other "meaningful event":
 *     SyncStatusPanel wires it into nothing extra itself (its manual
 *     "Run sync now" button already calls the underlying loader directly
 *     with `force: true`), but the shape exists so callers can route real
 *     state-changing actions through it without re-adding a timer.
 */
export function startSyncStatusWatch(options: {
  checkFreshness: () => Promise<void>;
  visibility?: VisibilitySource;
  /** How old the last check must be before a visibility-return triggers a new one. Defaults to 5 minutes. */
  staleAfterMs?: number;
}): SyncStatusWatch {
  const visibility = options.visibility ?? document;
  const staleAfterMs = Math.max(0, options.staleAfterMs ?? 5 * 60 * 1000);
  let stopped = false;
  let inFlight = false;
  let lastCheckedAt = 0;

  const runCheck = async () => {
    if (stopped || inFlight || visibility.visibilityState === "hidden") return;
    inFlight = true;
    lastCheckedAt = Date.now();
    try {
      await options.checkFreshness();
    } finally {
      inFlight = false;
    }
  };

  const handleVisibilityChange = () => {
    if (stopped || visibility.visibilityState !== "visible") return;
    const staleForMs = Date.now() - lastCheckedAt;
    if (lastCheckedAt === 0 || staleForMs >= staleAfterMs) {
      void runCheck();
    }
  };

  visibility.addEventListener("visibilitychange", handleVisibilityChange);
  if (visibility.visibilityState === "visible") void runCheck();

  return {
    stop: () => {
      stopped = true;
      visibility.removeEventListener("visibilitychange", handleVisibilityChange);
    },
    recheck: runCheck,
  };
}
