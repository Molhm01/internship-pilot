import { beforeEach, describe, expect, it, vi } from "vitest";

const scheduleAllUnscoredActiveJobs = vi.fn();
const getBulkInitialMatchStatus = vi.fn();

class BulkInitialMatchError extends Error {
  constructor(
    public code: string,
    public operation: string,
    public status: number,
  ) {
    super(code);
  }
}

vi.mock("@/lib/matching/bulkInitialMatch", () => ({
  BulkInitialMatchError,
  scheduleAllUnscoredActiveJobs: (...args: unknown[]) => scheduleAllUnscoredActiveJobs(...args),
  getBulkInitialMatchStatus: (...args: unknown[]) => getBulkInitialMatchStatus(...args),
}));

describe("bulk AI Match routes", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns scheduling counts without waiting for a model scorer", async () => {
    scheduleAllUnscoredActiveJobs.mockResolvedValue({
      ok: true,
      eligible: 18,
      queued: 18,
      skippedAlreadyScored: 384,
      skippedAlreadyQueued: 0,
      failedToQueue: 0,
    });
    const { POST } = await import("./route");
    const response = await POST();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      eligible: 18,
      queued: 18,
      skippedAlreadyScored: 384,
      skippedAlreadyQueued: 0,
      failedToQueue: 0,
    });
  });

  it("returns a clear migration-required response", async () => {
    scheduleAllUnscoredActiveJobs.mockRejectedValue(new BulkInitialMatchError(
      "AI_MATCH_QUEUE_MIGRATION_REQUIRED",
      "queue migration check",
      503,
    ));
    const { POST } = await import("./route");
    const response = await POST();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "AI_MATCH_QUEUE_MIGRATION_REQUIRED",
      message: "The AI Match queue migration is missing from the configured website database.",
    });
  });

  it("returns a sanitized scheduling failure", async () => {
    scheduleAllUnscoredActiveJobs.mockRejectedValue(new Error("private database detail"));
    const { POST } = await import("./route");
    const response = await POST();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: "BULK_SCORE_SCHEDULING_FAILED",
      message: "Unscored jobs could not be queued. Please try again.",
    });
  });

  it("returns current queue counts from the lightweight status route", async () => {
    getBulkInitialMatchStatus.mockResolvedValue({
      totalUnscored: 6,
      queued: 2,
      running: 1,
      completed: 9,
      failed: 3,
    });
    const { GET } = await import("./status/route");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: { totalUnscored: 6, queued: 2, running: 1, completed: 9, failed: 3 },
    });
  });
});
