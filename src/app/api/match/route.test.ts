import { beforeEach, describe, expect, it, vi } from "vitest";

const runMatchForJob = vi.fn();
const queueJobsForMatching = vi.fn();

vi.mock("@/lib/matching", () => ({
  MatchError: class MatchError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  },
  runMatchForJob: (...args: unknown[]) => runMatchForJob(...args),
}));

vi.mock("@/lib/matching/scoringQueue", () => ({
  queueJobsForMatching: (...args: unknown[]) => queueJobsForMatching(...args),
}));

describe("POST /api/match", () => {
  beforeEach(() => vi.resetAllMocks());

  it("runs and returns the completed persisted match for a manual job request", async () => {
    const persisted = {
      id: "match-1",
      jobId: "job-1",
      score: 84,
      eligibility: "Pass",
      skillsSupported: "[]",
      skillsNeverAdd: "[]",
    };
    runMatchForJob.mockResolvedValue(persisted);

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/match", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: "job-1" }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ matchResult: persisted });
    expect(runMatchForJob).toHaveBeenCalledWith("job-1");
    expect(queueJobsForMatching).not.toHaveBeenCalled();
  });

  it("returns a clear inline-safe error response", async () => {
    const { MatchError } = await import("@/lib/matching");
    runMatchForJob.mockRejectedValue(new MatchError("No approved resume facts yet.", 400));

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/match", {
      method: "POST",
      body: JSON.stringify({ jobId: "job-1" }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "No approved resume facts yet." });
  });

  it("retains the durable queue for bulk scoring only", async () => {
    queueJobsForMatching.mockResolvedValue({ requested: 10, newlyQueued: 8 });
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/match", {
      method: "POST",
      body: JSON.stringify({ allUnscored: true }),
    }));

    expect(await response.json()).toEqual({ requested: 10, newlyQueued: 8 });
    expect(queueJobsForMatching).toHaveBeenCalledWith({
      allUnscored: true,
      rescoreStale: false,
    });
    expect(runMatchForJob).not.toHaveBeenCalled();
  });
});
