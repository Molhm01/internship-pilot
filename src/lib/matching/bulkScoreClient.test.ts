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

  it("polls only while work is active and never overlaps status requests", async () => {
    vi.useFakeTimers();
    const visibility = new TestVisibility();
    let resolveFirst!: (value: typeof activeStatus) => void;
    const fetchStatus = vi.fn()
      .mockImplementationOnce(() => new Promise<typeof activeStatus>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(idleStatus);
    const cleanup = startBulkScoreStatusPolling({
      fetchStatus,
      onStatus: vi.fn(),
      visibility,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchStatus).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchStatus).toHaveBeenCalledOnce();
    resolveFirst(activeStatus);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("drops to the idle interval when nothing is queued/running, instead of continuing at the active cadence forever", async () => {
    // Database-usage audit (pass #3): keepWatchingWhenIdle used to mean
    // "keep polling at the SAME fast cadence forever" — six count() queries
    // every 15s indefinitely for an empty queue. It must now mean "keep
    // watching, but much less often" once idle.
    vi.useFakeTimers();
    const visibility = new TestVisibility();
    const fetchStatus = vi.fn().mockResolvedValue(idleStatus);
    const cleanup = startBulkScoreStatusPolling({
      fetchStatus,
      onStatus: vi.fn(),
      visibility,
      intervalMs: 15_000,
      idleIntervalMs: 120_000,
      keepWatchingWhenIdle: true,
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchStatus).toHaveBeenCalledOnce();
    // The active interval elapsing again must NOT trigger another poll —
    // idle work uses the slower idle interval, not the active one.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchStatus).toHaveBeenCalledOnce();
    // Advancing the rest of the way to the idle interval does poll again.
    await vi.advanceTimersByTimeAsync(120_000 - 15_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("stops polling in hidden tabs and cleans up on unmount", async () => {
    vi.useFakeTimers();
    const visibility = new TestVisibility();
    const fetchStatus = vi.fn().mockResolvedValue(activeStatus);
    const cleanup = startBulkScoreStatusPolling({
      fetchStatus,
      onStatus: vi.fn(),
      visibility,
    });

    visibility.setHidden(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchStatus).not.toHaveBeenCalled();
    visibility.setHidden(false);
    await Promise.resolve();
    expect(fetchStatus).toHaveBeenCalledOnce();
    cleanup();
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
