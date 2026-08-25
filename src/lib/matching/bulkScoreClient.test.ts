import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestScoreAllUnscored,
  runBulkScoreScheduling,
  startBulkScoreStatusPolling,
} from "./bulkScoreClient";

class TestVisibility extends EventTarget {
  visibilityState = "visible";

  setHidden(hidden: boolean) {
    this.visibilityState = hidden ? "hidden" : "visible";
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

const activeStatus = { totalUnscored: 3, queued: 2, running: 1, completed: 4, failed: 0 };
const idleStatus = { totalUnscored: 0, queued: 0, running: 0, completed: 7, failed: 0 };

describe("bulk score client", () => {
  afterEach(() => vi.useRealTimers());

  it("sends exactly one manual POST and recovers the button after success", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      eligible: 3,
      queued: 3,
      skippedAlreadyScored: 10,
      skippedAlreadyQueued: 0,
      failedToQueue: 0,
    }), { status: 200 }));
    const loading: boolean[] = [];
    const onSuccess = vi.fn();

    await runBulkScoreScheduling({
      fetcher,
      setScheduling: (value) => loading.push(value),
      onSuccess,
      onError: vi.fn(),
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("/api/jobs/score-unscored", { method: "POST" });
    expect(loading).toEqual([true, false]);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("accepts and displays the complete success counts contract", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      eligible: 18,
      queued: 18,
      skippedAlreadyScored: 384,
      skippedAlreadyQueued: 0,
      failedToQueue: 0,
    }), { status: 200 }));
    await expect(requestScoreAllUnscored(fetcher)).resolves.toMatchObject({
      eligible: 18,
      queued: 18,
      skippedAlreadyScored: 384,
      skippedAlreadyQueued: 0,
      failedToQueue: 0,
    });
  });

  it("recovers the button and exposes the safe API message after failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      message: "Unscored jobs could not be queued. Please try again.",
    }), { status: 500 }));
    const loading: boolean[] = [];
    const onError = vi.fn();

    await runBulkScoreScheduling({
      fetcher,
      setScheduling: (value) => loading.push(value),
      onSuccess: vi.fn(),
      onError,
    });

    expect(loading).toEqual([true, false]);
    expect(onError).toHaveBeenCalledWith("Unscored jobs could not be queued. Please try again.");
  });

  it("checks once immediately, then polls only while work is active", async () => {
    vi.useFakeTimers();
    const visibility = new TestVisibility();
    let resolveFirst!: (value: typeof activeStatus) => void;
    const fetchStatus = vi.fn()
      .mockImplementationOnce(() => new Promise<typeof activeStatus>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(idleStatus);
    const watch = startBulkScoreStatusPolling({
      fetchStatus,
      onStatus: vi.fn(),
      visibility,
    });

    // The very first check fires immediately on setup — no wasted "wait one
    // interval before the first request" delay, and no separate one-shot
    // effect needed on top of this watch (pass #5 removed exactly that
    // duplicate fetch from the Jobs page).
    await Promise.resolve();
    expect(fetchStatus).toHaveBeenCalledOnce();
    resolveFirst(activeStatus);
    await Promise.resolve();

    // Active (queued/running > 0): keeps polling at the active interval.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    // That second call resolved idle — no further timer should be scheduled.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    watch.stop();
  });

  it("idle schedules NOTHING — zero recurring requests until recheck() or visibility fires (pass #5)", async () => {
    // Pass #3 slowed idle polling from 15s to 2 minutes; pass #5 removes
    // idle polling entirely. An open tab with nothing to score must cost
    // zero database traffic on its own — not "less traffic", zero — until
    // something the caller considers a meaningful event calls recheck().
    vi.useFakeTimers();
    const visibility = new TestVisibility();
    const fetchStatus = vi.fn().mockResolvedValue(idleStatus);
    const watch = startBulkScoreStatusPolling({
      fetchStatus,
      onStatus: vi.fn(),
      visibility,
      intervalMs: 15_000,
    });

    await Promise.resolve();
    expect(fetchStatus).toHaveBeenCalledOnce();
    // No timer was scheduled after an idle result — advancing any amount of
    // time must never produce another request on its own.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(fetchStatus).toHaveBeenCalledOnce();

    // An explicit recheck() (the caller's job to wire into real "meaningful
    // events" — a sync completing, a job being added, ...) does one more
    // check, and — since still idle — schedules nothing further either.
    await watch.recheck();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    watch.stop();
  });

  it("the tab becoming visible again triggers exactly one recheck, not a resumed poll loop", async () => {
    vi.useFakeTimers();
    const visibility = new TestVisibility();
    const fetchStatus = vi.fn().mockResolvedValue(idleStatus);
    const watch = startBulkScoreStatusPolling({
      fetchStatus,
      onStatus: vi.fn(),
      visibility,
    });
    await Promise.resolve();
    expect(fetchStatus).toHaveBeenCalledOnce();

    visibility.setHidden(true);
    visibility.setHidden(false);
    await Promise.resolve();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    // Still idle after the visibility-triggered check — no timer left running.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    watch.stop();
  });

  it("stops checking in hidden tabs and cleans up on unmount", async () => {
    vi.useFakeTimers();
    const visibility = new TestVisibility();
    const fetchStatus = vi.fn().mockResolvedValue(activeStatus);
    visibility.setHidden(true);
    const watch = startBulkScoreStatusPolling({
      fetchStatus,
      onStatus: vi.fn(),
      visibility,
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchStatus).not.toHaveBeenCalled();
    visibility.setHidden(false);
    await Promise.resolve();
    expect(fetchStatus).toHaveBeenCalledOnce();
    watch.stop();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchStatus).toHaveBeenCalledOnce();
  });

  it("does not trigger bulk scoring on Jobs page load", () => {
    // Scoring is queued server-side; the page only watches the queue. Opening
    // Jobs must never schedule work, so what this guards is the absence of any
    // POST to the scheduling endpoint from the page itself.
    const source = readFileSync(resolve(process.cwd(), "src/app/(app)/jobs/page.tsx"), "utf8");
    expect(source).toContain("fetchBulkScoreStatus");
    expect(source).toContain("startBulkScoreStatusPolling");
    expect(source).not.toContain("requestScoreAllUnscored");
    expect(source).not.toContain("/api/jobs/score-unscored");
  });

  it("rejects malformed scheduling responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(requestScoreAllUnscored(fetcher)).rejects.toThrow("Unscored jobs could not be queued.");
  });
});
