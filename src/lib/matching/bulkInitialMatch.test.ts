import { beforeEach, describe, expect, it, vi } from "vitest";

const jobCount = vi.fn();
const jobFindMany = vi.fn();
const queueCount = vi.fn();
const scheduleInitialAiMatch = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    job: {
      count: (...args: unknown[]) => jobCount(...args),
      findMany: (...args: unknown[]) => jobFindMany(...args),
    },
    initialAiMatchJob: { count: (...args: unknown[]) => queueCount(...args) },
  },
}));

vi.mock("@/lib/matching/initialAiMatchQueue", () => ({
  scheduleInitialAiMatch: (...args: unknown[]) => scheduleInitialAiMatch(...args),
}));

import {
  BulkInitialMatchError,
  getBulkInitialMatchStatus,
  scheduleAllUnscoredActiveJobs,
} from "./bulkInitialMatch";

describe("bulk INITIAL AI Match scheduling", () => {
  beforeEach(() => vi.resetAllMocks());

  it("queues every unscored active job, skips valid scores, and skips active work", async () => {
    jobCount.mockResolvedValue(5);
    jobFindMany.mockResolvedValue([{ id: "job-1" }, { id: "job-2" }, { id: "job-3" }]);
    scheduleInitialAiMatch
      .mockResolvedValueOnce({ scheduled: true, reason: "SCHEDULED" })
      .mockResolvedValueOnce({ scheduled: false, reason: "ALREADY_SCHEDULED" })
      .mockResolvedValueOnce({ scheduled: true, reason: "SCHEDULED" });

    await expect(scheduleAllUnscoredActiveJobs()).resolves.toEqual({
      ok: true,
      eligible: 3,
      queued: 2,
      skippedAlreadyScored: 2,
      skippedAlreadyQueued: 1,
      failedToQueue: 0,
    });
    expect(scheduleInitialAiMatch).toHaveBeenCalledTimes(3);
    expect(scheduleInitialAiMatch).toHaveBeenNthCalledWith(1, "job-1", {
      retryFailed: true,
      startWorker: false,
    });
    expect(scheduleInitialAiMatch).toHaveBeenNthCalledWith(2, "job-2", {
      retryFailed: true,
      startWorker: false,
    });
    expect(scheduleInitialAiMatch).toHaveBeenNthCalledWith(3, "job-3", {
      retryFailed: true,
      startWorker: false,
    });
  });

  it("treats one duplicate as already queued and continues the batch", async () => {
    jobCount.mockResolvedValue(4);
    jobFindMany.mockResolvedValue([{ id: "job-1" }, { id: "job-duplicate" }, { id: "job-3" }]);
    scheduleInitialAiMatch
      .mockResolvedValueOnce({ scheduled: true, reason: "SCHEDULED" })
      .mockRejectedValueOnce(Object.assign(new Error("unique collision detail"), { code: "P2002" }))
      .mockResolvedValueOnce({ scheduled: true, reason: "SCHEDULED" });

    await expect(scheduleAllUnscoredActiveJobs()).resolves.toEqual({
      ok: true,
      eligible: 3,
      queued: 2,
      skippedAlreadyScored: 1,
      skippedAlreadyQueued: 1,
      failedToQueue: 0,
    });
    expect(scheduleInitialAiMatch).toHaveBeenCalledTimes(3);
  });

  it("counts a non-duplicate queue failure and continues the batch", async () => {
    jobCount.mockResolvedValue(3);
    jobFindMany.mockResolvedValue([{ id: "job-1" }, { id: "job-broken" }, { id: "job-3" }]);
    scheduleInitialAiMatch
      .mockResolvedValueOnce({ scheduled: true, reason: "SCHEDULED" })
      .mockRejectedValueOnce(Object.assign(new Error("database detail"), { code: "SQLITE_BUSY" }))
      .mockResolvedValueOnce({ scheduled: true, reason: "SCHEDULED" });

    await expect(scheduleAllUnscoredActiveJobs()).resolves.toEqual({
      ok: true,
      eligible: 3,
      queued: 2,
      skippedAlreadyScored: 0,
      skippedAlreadyQueued: 0,
      failedToQueue: 1,
    });
    expect(scheduleInitialAiMatch).toHaveBeenCalledTimes(3);
  });

  it("uses only active jobs without a valid denormalized or canonical score", async () => {
    jobCount.mockResolvedValue(0);
    jobFindMany.mockResolvedValue([]);
    await scheduleAllUnscoredActiveJobs();

    expect(jobFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        activeFeed: true,
        AND: expect.arrayContaining([
          expect.objectContaining({ matchResults: { none: { score: { gte: 0, lte: 100 } } } }),
        ]),
      }),
    }));
    expect(scheduleInitialAiMatch).not.toHaveBeenCalled();
  });

  it("reports lightweight queue status counts", async () => {
    jobCount.mockResolvedValueOnce(8);
    queueCount
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);

    await expect(getBulkInitialMatchStatus()).resolves.toEqual({
      totalUnscored: 8,
      queued: 4,
      running: 1,
      completed: 12,
      failed: 5,
    });
  });

  it("reports a clear migration error before attempting scheduling", async () => {
    queueCount.mockRejectedValueOnce(Object.assign(new Error("no such table: InitialAiMatchJob"), {
      code: "P2021",
    }));
    await expect(scheduleAllUnscoredActiveJobs()).rejects.toMatchObject({
      code: "AI_MATCH_QUEUE_MIGRATION_REQUIRED",
      operation: "queue migration check",
      status: 503,
    });
    expect(jobFindMany).not.toHaveBeenCalled();
    expect(scheduleInitialAiMatch).not.toHaveBeenCalled();
  });

  it("defines a restart-required diagnostic for a stale generated Prisma client", () => {
    const error = new BulkInitialMatchError(
      "AI_MATCH_QUEUE_CLIENT_RESTART_REQUIRED",
      "queue migration check",
      503,
    );
    expect(error).toMatchObject({
      code: "AI_MATCH_QUEUE_CLIENT_RESTART_REQUIRED",
      status: 503,
    });
  });

  it("has no application automation dependency", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./bulkInitialMatch.ts", import.meta.url), "utf8");
    expect(source).not.toContain("ApplicationSession");
    expect(source).not.toContain("application-worker");
    expect(source).not.toContain("applications/queue");
  });
});
