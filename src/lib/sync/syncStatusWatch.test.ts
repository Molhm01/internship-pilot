import { afterEach, describe, expect, it, vi } from "vitest";
import { startSyncStatusWatch } from "./syncStatusWatch";

class TestVisibility extends EventTarget {
  visibilityState = "visible";

  setHidden(hidden: boolean) {
    this.visibilityState = hidden ? "hidden" : "visible";
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

describe("sync status watch", () => {
  afterEach(() => vi.useRealTimers());

  it("checks once on mount, then schedules NOTHING for a continuously visible idle tab", async () => {
    // Database-usage repair, pass #6: no recurring timer at all — this is
    // what makes an 8-hour idle visible tab with zero tab-switches cost
    // exactly one server check for the entire session.
    vi.useFakeTimers();
    const visibility = new TestVisibility();
    const checkFreshness = vi.fn().mockResolvedValue(undefined);
    const watch = startSyncStatusWatch({ checkFreshness, visibility });

    await Promise.resolve();
    expect(checkFreshness).toHaveBeenCalledOnce();

    // 8 simulated hours with no visibility change and no recheck() call.
    await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
    expect(checkFreshness).toHaveBeenCalledOnce();
    watch.stop();
  });

  it("does not check on mount when the tab starts hidden", async () => {
    vi.useFakeTimers();
    const visibility = new TestVisibility();
    visibility.setHidden(true);
    const checkFreshness = vi.fn().mockResolvedValue(undefined);
    const watch = startSyncStatusWatch({ checkFreshness, visibility });

    await Promise.resolve();
    expect(checkFreshness).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
    expect(checkFreshness).not.toHaveBeenCalled();
    watch.stop();
  });

  it("visible -> hidden -> visible triggers exactly one more check (if stale), not a resumed poll loop", async () => {
    vi.useFakeTimers();
    const visibility = new TestVisibility();
    const checkFreshness = vi.fn().mockResolvedValue(undefined);
    const watch = startSyncStatusWatch({ checkFreshness, visibility, staleAfterMs: 5 * 60 * 1000 });

    await Promise.resolve();
    expect(checkFreshness).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(6 * 60 * 1000); // past staleAfterMs
    visibility.setHidden(true);
    visibility.setHidden(false);
    await Promise.resolve();
    expect(checkFreshness).toHaveBeenCalledTimes(2);

    // No further timer was scheduled after that — advancing 8 more hours
    // with no further visibility change produces no more checks.
    await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
    expect(checkFreshness).toHaveBeenCalledTimes(2);
    watch.stop();
  });

  it("a brief tab switch (still fresh) does not trigger a redundant check", async () => {
    vi.useFakeTimers();
    const visibility = new TestVisibility();
    const checkFreshness = vi.fn().mockResolvedValue(undefined);
    const watch = startSyncStatusWatch({ checkFreshness, visibility, staleAfterMs: 5 * 60 * 1000 });

    await Promise.resolve();
    expect(checkFreshness).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30 * 1000); // well under staleAfterMs
    visibility.setHidden(true);
    visibility.setHidden(false);
    await Promise.resolve();
    expect(checkFreshness).toHaveBeenCalledOnce();
    watch.stop();
  });

  it("recheck() triggers one immediate check and resets the staleness clock", async () => {
    vi.useFakeTimers();
    const visibility = new TestVisibility();
    const checkFreshness = vi.fn().mockResolvedValue(undefined);
    const watch = startSyncStatusWatch({ checkFreshness, visibility, staleAfterMs: 5 * 60 * 1000 });
    await Promise.resolve();
    expect(checkFreshness).toHaveBeenCalledOnce();

    await watch.recheck();
    expect(checkFreshness).toHaveBeenCalledTimes(2);

    // A visibility toggle immediately after recheck() must not double-check
    // — the clock recheck() advanced counts too.
    visibility.setHidden(true);
    visibility.setHidden(false);
    await Promise.resolve();
    expect(checkFreshness).toHaveBeenCalledTimes(2);
    watch.stop();
  });

  it("stop() prevents any further checks", async () => {
    vi.useFakeTimers();
    const visibility = new TestVisibility();
    const checkFreshness = vi.fn().mockResolvedValue(undefined);
    const watch = startSyncStatusWatch({ checkFreshness, visibility });
    await Promise.resolve();
    expect(checkFreshness).toHaveBeenCalledOnce();

    watch.stop();
    visibility.setHidden(true);
    visibility.setHidden(false);
    await Promise.resolve();
    expect(checkFreshness).toHaveBeenCalledOnce();
  });
});
