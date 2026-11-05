import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { syncLog: { updateMany: (...args: unknown[]) => updateMany(...args) } },
}));

import { STALE_RUNNING_MS, recoverStaleSyncRuns } from "./syncRuns";

describe("recoverStaleSyncRuns", () => {
  beforeEach(() => vi.resetAllMocks());

  it("marks only running rows older than the stale threshold as recovered errors", async () => {
    updateMany.mockResolvedValue({ count: 2 });
    const now = new Date("2026-11-05T12:00:00Z");

    const recovered = await recoverStaleSyncRuns(now);

    expect(recovered).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { status: "running", startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
      data: {
        status: "error",
        finishedAt: now,
        errorMessage:
          "stale:recovered - exceeded 15m without completing; the function died or lost its database connection",
      },
    });
  });

  it("uses a threshold comfortably above the 300s cron function cap", () => {
    expect(STALE_RUNNING_MS).toBeGreaterThan(300_000);
  });

  it("returns zero when nothing is stale", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    expect(await recoverStaleSyncRuns()).toBe(0);
  });
});
