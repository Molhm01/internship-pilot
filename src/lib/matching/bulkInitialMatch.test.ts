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

// Partial mock: only the scheduling call is replaced. `INITIAL_MATCH_TYPE` is a
// real constant the module under test reads, and a mock that dropped it turned
// every case in this suite into an unrelated BULK_SCORE_QUERY_FAILED.
vi.mock("@/lib/matching/initialAiMatchQueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/matching/initialAiMatchQueue")>()),
  scheduleInitialAiMatch: (...args: unknown[]) => scheduleInitialAiMatch(...args),
}));

import {
  BulkInitialMatchError,
  getBulkInitialMatchStatus,
  scheduleAllUnscoredActiveJobs,
} from "./bulkInitialMatch";

/** The owner every scoring call is made for in this suite. */
const TEST_USER = "test-user";

describe("bulk INITIAL AI Match scheduling", () => {
  beforeEach(() => vi.resetAllMocks());

  it("queues every unscored active job, skips valid scores, and skips active work", async () => {
    jobCount.mockResolvedValue(5);
    jobFindMany.mockResolvedValue([{ id: "job-1" }, { id: "job-2" }, { id: "job-3" }]);
    scheduleInitialAiMatch
      .mockResolvedValueOnce({ scheduled: true, reason: "SCHEDULED" })
      .mockResolvedValueOnce({ scheduled: false, reason: "ALREADY_SCHEDULED" })
      .mockResolvedValueOnce({ scheduled: true, reason: "SCHEDULED" });

    await expect(scheduleAllUnscoredActiveJobs(TEST_USER)).resolves.toEqual({
      ok: true,
      eligible: 3,
      queued: 2,
      skippedAlreadyScored: 2,
      skippedAlreadyQueued: 1,
      failedToQueue: 0,
    });
    expect(scheduleInitialAiMatch).toHaveBeenCalledTimes(3);
    expect(scheduleInitialAiMatch).toHaveBeenNthCalledWith(1, "job-1", TEST_USER, {
      retryFailed: true,
      startWorker: false,
    });
    expect(scheduleInitialAiMatch).toHaveBeenNthCalledWith(2, "job-2", TEST_USER, {
      retryFailed: true,
      startWorker: false,
    });
    expect(scheduleInitialAiMatch).toHaveBeenNthCalledWith(3, "job-3", TEST_USER, {
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

    await expect(scheduleAllUnscoredActiveJobs(TEST_USER)).resolves.toEqual({
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

    await expect(scheduleAllUnscoredActiveJobs(TEST_USER)).resolves.toEqual({
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
    await scheduleAllUnscoredActiveJobs(TEST_USER);

    expect(jobFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        activeFeed: true,
        AND: expect.arrayContaining([
          // Scoped to this user: "unscored" is a fact about a person and a
          // job, not about the shared posting.
          expect.objectContaining({
            matchResults: { none: { userId: TEST_USER, score: { gte: 0, lte: 100 } } },
          }),
        ]),
      }),
    }));
    expect(scheduleInitialAiMatch).not.toHaveBeenCalled();
  });

  it("reports lightweight queue status counts", async () => {
    // `completed` is counted from the user's own scored jobs, not from the
    // queue, so it is a Job count sitting between the two queue counts.
    jobCount
      .mockResolvedValueOnce(8) // totalUnscored
      .mockResolvedValueOnce(12); // completed
    queueCount
      .mockResolvedValueOnce(0) // readiness probe
      .mockResolvedValueOnce(4) // queued
      .mockResolvedValueOnce(1) // running
      .mockResolvedValueOnce(2) // retryable failed
      .mockResolvedValueOnce(3); // permanent failed

    await expect(getBulkInitialMatchStatus(TEST_USER)).resolves.toEqual({
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
    await expect(scheduleAllUnscoredActiveJobs(TEST_USER)).rejects.toMatchObject({
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
