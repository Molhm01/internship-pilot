import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runMatchForJob = vi.fn();

vi.mock("@/lib/matching", () => ({
  MatchError: class MatchError extends Error {
    constructor(
      message: string,
      public status = 500,
      public code = "MATCH_FAILED",
    ) {
      super(message);
    }
  },
  runMatchForJob: (...args: unknown[]) => runMatchForJob(...args),
}));

describe("POST /api/match", () => {
  beforeEach(() => vi.resetAllMocks());

  it("runs and returns the completed persisted match for a manual job request", async () => {
    const persisted = {
      id: "match-1",
      jobId: "job-1",
      score: 84,
      eligibility: "Pass",
      eligibilityReason: "Pass based only on approved evidence.",
      explanation: "One qualification is supported; unsupported requirements are separate.",
      skillsSupported: JSON.stringify([{
        skill: "Python",
        reason: "private-candidate-detail-should-not-be-returned",
        factIds: ["private-fact-id"],
      }]),
      skillsNeedConfirmation: JSON.stringify([{ skill: "Embedded C" }]),
      skillsToLearn: JSON.stringify([{ skill: "Rust" }]),
      skillsNeverAdd: JSON.stringify([{ skill: "Civil Engineering degree" }]),
    };
    runMatchForJob.mockResolvedValue(persisted);

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/match", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: "job-1" }),
    }), {});

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      match: {
        eligibility: "PASS",
        score: 84,
        reasoning: "Pass based only on approved evidence. One qualification is supported; unsupported requirements are separate.",
        matchingQualifications: ["Python"],
        missingQualifications: ["Embedded C"],
        skillsToLearn: ["Rust"],
        neverClaim: ["Civil Engineering degree"],
      },
    });
    expect(JSON.stringify(body)).not.toContain("private-candidate-detail");
    expect(JSON.stringify(body)).not.toContain("private-fact-id");
    expect(runMatchForJob).toHaveBeenCalledWith("job-1", { userId: "test-user", origin: "MANUAL" });
  });

  it("returns a clear inline-safe error response", async () => {
    const { MatchError } = await import("@/lib/matching");
    runMatchForJob.mockRejectedValue(new MatchError(
      "No approved resume facts yet.",
      400,
      "PROFILE_FACTS_MISSING",
    ));

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/match", {
      method: "POST",
      body: JSON.stringify({ jobId: "job-1" }),
    }), {});

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "PROFILE_FACTS_MISSING",
      message: "No approved resume facts yet.",
    });
  });

  it("rejects legacy bulk-scoring payloads without running a match", async () => {
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/match", {
      method: "POST",
      body: JSON.stringify({ allUnscored: true }),
    }), {});

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "INVALID_REQUEST",
      message: "A single job ID is required to run AI Match manually.",
    });
    expect(runMatchForJob).not.toHaveBeenCalled();
  });

  it("keeps bulk scoring separate from the manual single-job route", () => {
    const routeSource = readFileSync(resolve(process.cwd(), "src/app/api/match/route.ts"), "utf8");
    const jobsPageSource = readFileSync(resolve(process.cwd(), "src/app/(app)/jobs/page.tsx"), "utf8");
    const schedulerSource = readFileSync(resolve(process.cwd(), "src/lib/sync/scheduler.ts"), "utf8");

    expect(routeSource).not.toContain("queueJobsForMatching");
    expect(routeSource).not.toContain("allUnscored");
    expect(routeSource).not.toContain("rescoreStale");
    expect(jobsPageSource).not.toContain("Rescore Stale Jobs");
    expect(jobsPageSource).not.toContain('fetch("/api/match"');
    expect(jobsPageSource).not.toContain("allUnscored");
    expect(schedulerSource).not.toContain("triggerScoringWorker");
    expect(schedulerSource).not.toContain("scoringQueue");
  });
});

// Route handlers authenticate through this module. The tests below call them
// directly, so a session has to exist; who it belongs to is exercised by
// src/lib/auth/multiUserIsolation.test.ts against a real database.
vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
  const user = { id: "test-user", email: "test@example.test", name: "Test", image: null, emailVerified: true };
  return {
    ...actual,
    currentUser: async () => user,
    requireUser: async () => user,
    guardSession: async () => null,
    withUser:
      <C>(handler: (request: Request, sessionUser: typeof user, context: C) => Promise<Response>) =>
      async (request: Request, context: C) =>
        handler(request, user, context),
  };
});
