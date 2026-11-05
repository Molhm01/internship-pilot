import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { syncLog: { updateMany: (...args: unknown[]) => updateMany(...args) } },
}));

import { RECOVERABLE_SOURCES, STALE_RUNNING_MS, recoverStaleSyncRuns } from "./syncRuns";

describe("recoverStaleSyncRuns", () => {
  beforeEach(() => vi.resetAllMocks());

  it("marks only running rows older than the threshold from Vercel-bounded sources", async () => {
    updateMany.mockResolvedValue({ count: 2 });
    const now = new Date("2026-11-05T12:00:00Z");

    const recovered = await recoverStaleSyncRuns(now);

    expect(recovered).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        status: "running",
        startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) },
        OR: [{ source: { in: [...RECOVERABLE_SOURCES] } }, { source: { startsWith: "cron:" } }],
      },
      data: {
        status: "error",
        finishedAt: now,
        errorMessage:
          "stale:recovered - exceeded 15m without completing; the function died or lost its database connection",
      },
    });
  });

  it("uses a strict-older-than cutoff so a run exactly at the threshold is left alone", () => {
    // lt, not lte: a row at precisely now-15m is still within tolerance and
    // must not be recovered. The boundary is asserted through the query the
    // function issues, not just its arithmetic.
    updateMany.mockResolvedValue({ count: 0 });
    const now = new Date("2026-11-05T12:00:00Z");
    return recoverStaleSyncRuns(now).then(() => {
      const where = updateMany.mock.calls[0][0].where;
      expect(where.startedAt.lt).toEqual(new Date(now.getTime() - STALE_RUNNING_MS));
      expect(where.startedAt.lte).toBeUndefined();
    });
  });

  it("never recovers intern-list rows, which a local uncapped scheduler can produce", () => {
    expect(RECOVERABLE_SOURCES).not.toContain("intern-list");
  });

  it("uses a threshold comfortably above the 300s cron function cap", () => {
    expect(STALE_RUNNING_MS).toBeGreaterThan(3 * 300_000 - 1);
  });

  it("returns zero when nothing is stale", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    expect(await recoverStaleSyncRuns()).toBe(0);
  });
});
