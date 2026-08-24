import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jobFindUnique = vi.fn();
const jobUpdate = vi.fn();
const factCount = vi.fn();
const queueCreate = vi.fn();
const queueFindFirst = vi.fn();
const queueFindMany = vi.fn();
const queueUpdate = vi.fn();
const queueUpdateMany = vi.fn();
const transaction = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    job: {
      findUnique: (...args: unknown[]) => jobFindUnique(...args),
      update: (...args: unknown[]) => jobUpdate(...args),
    },
    resumeFact: { count: (...args: unknown[]) => factCount(...args) },
    initialAiMatchJob: {
      create: (...args: unknown[]) => queueCreate(...args),
      findFirst: (...args: unknown[]) => queueFindFirst(...args),
      findMany: (...args: unknown[]) => queueFindMany(...args),
      update: (...args: unknown[]) => queueUpdate(...args),
      updateMany: (...args: unknown[]) => queueUpdateMany(...args),
    },
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}));

import { MatchError } from "@/lib/matching";
import {
  __setInitialAiMatchScorerForTests,
  __stopInitialAiMatchWorkerForTests,
  INITIAL_MATCH_MAX_ATTEMPTS,
  INITIAL_MATCH_ORIGIN,
  initialAiMatchWorkerConcurrency,
  processNextInitialAiMatch,
  runBoundedInitialMatchWorkers,
  scheduleInitialAiMatch,
} from "./initialAiMatchQueue";

/** The owner every scoring call is made for in this suite. */
const TEST_USER = "test-user";

const schedulableJob = {
  id: "job-new",
  userStates: [],
  description: "Build and test embedded firmware, analyze device data, document results, and collaborate with engineers throughout the product lifecycle.",
  jobResponsibilities: null,
  jobQualifications: null,
  matchResults: [],
  initialAiMatchJobs: [],
};

const completeMatch = {
  id: "match-initial",
  score: 86,
  eligibility: "Pass",
  eligibilityReason: "Approved evidence supports the core requirements.",
  explanation: "Unsupported requirements remain separated.",
  skillsSupported: "[]",
  skillsNeedConfirmation: "[]",
  skillsToLearn: "[]",
  skillsNeverAdd: "[]",
  origin: INITIAL_MATCH_ORIGIN,
};

describe("durable INITIAL AI Match queue", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    jobFindUnique.mockResolvedValue(schedulableJob);
    factCount.mockResolvedValue(3);
    queueCreate.mockResolvedValue({ id: "initial-work" });
    queueFindMany.mockResolvedValue([]);
    queueUpdate.mockResolvedValue({});
    queueUpdateMany.mockResolvedValue({ count: 1 });
    jobUpdate.mockResolvedValue({});
    transaction.mockImplementation((operations: Promise<unknown>[]) => Promise.all(operations));
  });

  afterEach(() => {
    __stopInitialAiMatchWorkerForTests();
    __setInitialAiMatchScorerForTests(null);
  });

  it("selects runnable AI work by source freshness before backlog age", async () => {
    queueFindFirst.mockResolvedValue(null);
    await expect(processNextInitialAiMatch(new Date("2026-08-24T12:00:00.000Z"))).resolves.toBe(false);
    expect(queueFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [
        { job: { sourcePostedAt: { sort: "desc", nulls: "last" } } },
        { nextAttemptAt: "asc" },
        { createdAt: "asc" },
        { id: "asc" },
      ],
    }));
  });

  it("schedules a genuinely new job once and deduplicates repeated events", async () => {
    const backgroundScorer = vi.fn();
    __setInitialAiMatchScorerForTests(backgroundScorer);
    await expect(scheduleInitialAiMatch("job-new", TEST_USER)).resolves.toEqual({
      scheduled: true,
      reason: "SCHEDULED",
    });
    expect(backgroundScorer).not.toHaveBeenCalled();
    jobFindUnique.mockResolvedValueOnce({
      ...schedulableJob,
      initialAiMatchJobs: [{ id: "initial-work", state: "PENDING" }],
    });
    await expect(scheduleInitialAiMatch("job-new", TEST_USER)).resolves.toEqual({
      scheduled: false,
      reason: "ALREADY_SCHEDULED",
    });

    expect(queueCreate).toHaveBeenCalledOnce();
    expect(queueCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      jobId: "job-new",
      matchType: "INITIAL",
      state: "PENDING",
    }) });
  });

  it("requeues an explicitly retried failed INITIAL job without creating a duplicate", async () => {
    jobFindUnique.mockResolvedValueOnce({
      ...schedulableJob,
      initialAiMatchJobs: [{ id: "initial-failed", state: "PERMANENT_FAILED" }],
    });

    await expect(scheduleInitialAiMatch("job-new", TEST_USER, { retryFailed: true })).resolves.toEqual({
      scheduled: true,
      reason: "SCHEDULED",
    });

    expect(queueCreate).not.toHaveBeenCalled();
    expect(queueUpdate).toHaveBeenCalledWith({
      where: { id: "initial-failed" },
      data: expect.objectContaining({
        state: "PENDING",
        attemptCount: 0,
        lastErrorCode: null,
        completedAt: null,
      }),
    });
  });

  it("does not schedule a job with a valid score, missing description, or missing profile facts", async () => {
    jobFindUnique.mockResolvedValueOnce({
      ...schedulableJob,
      matchResults: [{ id: "existing-match" }],
    });
    await expect(scheduleInitialAiMatch("scored-job", TEST_USER)).resolves.toMatchObject({
      scheduled: false,
      reason: "ALREADY_SCORED",
    });

    jobFindUnique.mockResolvedValueOnce({ ...schedulableJob, userStates: [{ matchScore: 77 }] });
    await expect(scheduleInitialAiMatch("legacy-scored-job", TEST_USER, { retryFailed: true })).resolves.toMatchObject({
      scheduled: false,
      reason: "ALREADY_SCORED",
    });

    jobFindUnique.mockResolvedValueOnce({ ...schedulableJob, description: "short" });
    await expect(scheduleInitialAiMatch("incomplete-job", TEST_USER)).resolves.toMatchObject({
      scheduled: false,
      reason: "JOB_DESCRIPTION_INSUFFICIENT",
    });

    factCount.mockResolvedValueOnce(0);
    await expect(scheduleInitialAiMatch("no-profile-job", TEST_USER)).resolves.toMatchObject({
      scheduled: false,
      reason: "PROFILE_FACTS_MISSING",
    });
    expect(queueCreate).not.toHaveBeenCalled();
  });

  it("retries an offline model, then persists a complete INITIAL_AUTO result when available", async () => {
    const now = new Date("2026-08-01T12:00:00.000Z");
    queueFindFirst.mockResolvedValueOnce({ userId: TEST_USER,
      id: "initial-work",
      jobId: "job-new",
      state: "PENDING",
      attemptCount: 0,
    });
    jobFindUnique.mockResolvedValueOnce({ matchResults: [], userStates: [] });
    const scorer = vi.fn()
      .mockRejectedValueOnce(new MatchError("offline", 503, "MODEL_UNAVAILABLE"))
      .mockResolvedValueOnce(completeMatch);
    __setInitialAiMatchScorerForTests(scorer);

    await processNextInitialAiMatch(now);
    expect(queueUpdate).toHaveBeenCalledWith({
      where: { id: "initial-work" },
      data: expect.objectContaining({
        state: "RETRYABLE_FAILED",
        lastErrorCode: "MODEL_UNAVAILABLE",
        nextAttemptAt: new Date("2026-08-01T12:01:00.000Z"),
      }),
    });

    queueFindFirst.mockResolvedValueOnce({ userId: TEST_USER,
      id: "initial-work",
      jobId: "job-new",
      state: "RETRYABLE_FAILED",
      attemptCount: 1,
    });
    jobFindUnique.mockResolvedValueOnce({ matchResults: [], userStates: [] });
    await processNextInitialAiMatch(new Date("2026-08-01T12:01:00.000Z"));

    expect(scorer).toHaveBeenLastCalledWith("job-new", { userId: TEST_USER, origin: "INITIAL_AUTO" });
    expect(queueUpdate).toHaveBeenLastCalledWith({
      where: { id: "initial-work" },
      data: expect.objectContaining({
        state: "SUCCEEDED",
        matchResultId: "match-initial",
        lastErrorCode: null,
      }),
    });
  });

  it("stops retrying transient failures at the bounded attempt limit", async () => {
    const scorer = vi.fn().mockRejectedValue(new MatchError("offline", 503, "MODEL_UNAVAILABLE"));
    __setInitialAiMatchScorerForTests(scorer);
    queueFindFirst.mockResolvedValue({ userId: TEST_USER,
      id: "initial-work",
      jobId: "job-new",
      state: "RETRYABLE_FAILED",
      attemptCount: INITIAL_MATCH_MAX_ATTEMPTS - 1,
    });
    jobFindUnique.mockResolvedValue({ matchResults: [], userStates: [] });

    await processNextInitialAiMatch(new Date("2026-08-01T12:10:00.000Z"));

    expect(queueUpdate).toHaveBeenLastCalledWith({
      where: { id: "initial-work" },
      data: expect.objectContaining({
        state: "PERMANENT_FAILED",
        lastErrorCode: "MODEL_UNAVAILABLE",
      }),
    });
  });

  it("releases a timed-out queue item for a bounded retry", async () => {
    const now = new Date("2026-08-01T12:00:00.000Z");
    queueFindFirst.mockResolvedValueOnce({ userId: TEST_USER,
      id: "initial-timeout",
      jobId: "job-timeout",
      state: "PENDING",
      attemptCount: 0,
      createdAt: new Date("2026-08-01T11:59:30.000Z"),
    });
    jobFindUnique.mockResolvedValueOnce({ matchResults: [], userStates: [] });
    __setInitialAiMatchScorerForTests(vi.fn().mockRejectedValue(
      new MatchError("timed out", 504, "MODEL_TIMEOUT"),
    ));

    await processNextInitialAiMatch(now);

    expect(queueUpdate).toHaveBeenCalledWith({
      where: { id: "initial-timeout" },
      data: expect.objectContaining({
        state: "RETRYABLE_FAILED",
        lockedAt: null,
        lastErrorCode: "MODEL_TIMEOUT",
        nextAttemptAt: new Date("2026-08-01T12:01:00.000Z"),
      }),
    });
  });

  it("marks a permanent prerequisite failure without scheduling another attempt", async () => {
    const scorer = vi.fn().mockRejectedValue(new MatchError(
      "description missing",
      400,
      "JOB_DESCRIPTION_INSUFFICIENT",
    ));
    __setInitialAiMatchScorerForTests(scorer);
    queueFindFirst.mockResolvedValue({ userId: TEST_USER,
      id: "initial-work",
      jobId: "job-new",
      state: "PENDING",
      attemptCount: 0,
    });
    jobFindUnique.mockResolvedValue({ matchResults: [], userStates: [] });

    await processNextInitialAiMatch(new Date("2026-08-01T12:00:00.000Z"));

    expect(queueUpdate).toHaveBeenLastCalledWith({
      where: { id: "initial-work" },
      data: expect.objectContaining({
        state: "PERMANENT_FAILED",
        lastErrorCode: "JOB_DESCRIPTION_INSUFFICIENT",
      }),
    });
  });

  it("continues with the next queued job after another job fails", async () => {
    const scorer = vi.fn()
      .mockRejectedValueOnce(new MatchError("invalid", 502, "MODEL_RESPONSE_INVALID"))
      .mockResolvedValueOnce({ ...completeMatch, id: "match-second" });
    __setInitialAiMatchScorerForTests(scorer);
    queueFindFirst
      .mockResolvedValueOnce({
        id: "initial-first",
        userId: TEST_USER,
        jobId: "job-first",
        state: "PENDING",
        attemptCount: 0,
      })
      .mockResolvedValueOnce({
        id: "initial-second",
        userId: TEST_USER,
        jobId: "job-second",
        state: "PENDING",
        attemptCount: 0,
      });
    jobFindUnique
      .mockResolvedValueOnce({ matchResults: [], userStates: [] })
      .mockResolvedValueOnce({ matchResults: [], userStates: [] });

    await processNextInitialAiMatch(new Date("2026-08-01T13:00:00.000Z"));
    await processNextInitialAiMatch(new Date("2026-08-01T13:00:01.000Z"));

    expect(scorer).toHaveBeenNthCalledWith(1, "job-first", { userId: TEST_USER, origin: "INITIAL_AUTO" });
    expect(scorer).toHaveBeenNthCalledWith(2, "job-second", { userId: TEST_USER, origin: "INITIAL_AUTO" });
    expect(queueUpdate).toHaveBeenCalledWith({
      where: { id: "initial-first" },
      data: expect.objectContaining({ state: "PERMANENT_FAILED" }),
    });
    expect(queueUpdate).toHaveBeenCalledWith({
      where: { id: "initial-second" },
      data: expect.objectContaining({ state: "SUCCEEDED", matchResultId: "match-second" }),
    });
  });

  it("caps worker concurrency at two and falls back to one under memory pressure", async () => {
    expect(initialAiMatchWorkerConcurrency("2", 16 * 1024 ** 3)).toBe(2);
    expect(initialAiMatchWorkerConcurrency("8", 16 * 1024 ** 3)).toBe(2);
    expect(initialAiMatchWorkerConcurrency("2", 4 * 1024 ** 3)).toBe(1);

    let remaining = 5;
    let active = 0;
    let maximumActive = 0;
    await runBoundedInitialMatchWorkers(async () => {
      if (remaining <= 0) return false;
      remaining -= 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return true;
    }, 2);
    expect(maximumActive).toBe(2);
  });

  it("allows only one of two workers to atomically claim the same queue row", async () => {
    const pending = {
      id: "initial-shared",
      userId: TEST_USER,
      jobId: "job-shared",
      state: "PENDING",
      attemptCount: 0,
      createdAt: new Date("2026-08-01T11:59:00.000Z"),
    };
    queueFindFirst
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(null);
    queueUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    jobFindUnique.mockResolvedValue({ matchResults: [], userStates: [] });
    const scorer = vi.fn().mockResolvedValue(completeMatch);
    __setInitialAiMatchScorerForTests(scorer);

    await runBoundedInitialMatchWorkers(
      () => processNextInitialAiMatch(new Date("2026-08-01T12:00:00.000Z")),
      2,
    );

    expect(scorer).toHaveBeenCalledOnce();
    expect(scorer).toHaveBeenCalledWith("job-shared", { userId: TEST_USER, origin: "INITIAL_AUTO" });
  });

  it("does not retry an invalid result and never changes an existing saved score", async () => {
    const scorer = vi.fn().mockResolvedValue({ ...completeMatch, score: 101 });
    __setInitialAiMatchScorerForTests(scorer);
    queueFindFirst.mockResolvedValueOnce({ userId: TEST_USER,
      id: "initial-work",
      jobId: "job-new",
      state: "PENDING",
      attemptCount: 0,
    });
    jobFindUnique.mockResolvedValueOnce({ matchResults: [], userStates: [] });
    await processNextInitialAiMatch();
    expect(queueUpdate).toHaveBeenLastCalledWith({
      where: { id: "initial-work" },
      data: expect.objectContaining({ state: "PERMANENT_FAILED", lastErrorCode: "MODEL_RESPONSE_INVALID" }),
    });

    vi.resetAllMocks();
    queueFindMany.mockResolvedValue([]);
    queueFindFirst.mockResolvedValueOnce({ userId: TEST_USER,
      id: "initial-existing",
      jobId: "job-scored",
      state: "PENDING",
      attemptCount: 0,
    });
    queueUpdateMany.mockResolvedValue({ count: 1 });
    queueUpdate.mockResolvedValue({});
    jobUpdate.mockResolvedValue({});
    transaction.mockImplementation((operations: Promise<unknown>[]) => Promise.all(operations));
    jobFindUnique.mockResolvedValueOnce({ matchResults: [{ id: "match-existing" }], userStates: [] });
    const existingScorer = vi.fn();
    __setInitialAiMatchScorerForTests(existingScorer);
    await processNextInitialAiMatch();

    expect(existingScorer).not.toHaveBeenCalled();
    expect(jobUpdate.mock.calls.every(([argument]) =>
      !("matchScore" in ((argument as { data: Record<string, unknown> }).data)),
    )).toBe(true);
  });

  it("never starts the Ollama-backed scorer in a cloud runtime", async () => {
    // Scoring runs on the user's own machine. On Vercel, localhost:11434 is
    // the serverless function itself, so a worker started there does not fail
    // fast — it spends the whole invocation timing out against a port nobody
    // is listening on. Hosted ingestion already passes `startWorker: false`;
    // this is the guarantee rather than the convention.
    const cloudScorer = vi.fn();
    __setInitialAiMatchScorerForTests(cloudScorer);
    queueFindMany.mockResolvedValue([
      { id: "initial-work", jobId: "job-new", userId: TEST_USER, matchType: "INITIAL", attemptCount: 0 },
    ]);

    const previous = process.env.INTERNSHIP_PILOT_RUNTIME;
    process.env.INTERNSHIP_PILOT_RUNTIME = "cloud";
    try {
      const { triggerInitialAiMatchWorker } = await import("@/lib/matching/initialAiMatchQueue");
      triggerInitialAiMatchWorker();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(cloudScorer).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.INTERNSHIP_PILOT_RUNTIME;
      else process.env.INTERNSHIP_PILOT_RUNTIME = previous;
    }
  });

  it("keeps every hosted ingestion lane on the queue-only path", () => {
    for (const lane of ["fresh", "standard", "maintenance"]) {
      const source = readFileSync(
        resolve(process.cwd(), `src/app/api/cron/job-ingestion/${lane}/route.ts`),
        "utf8",
      );
      expect(source, `${lane} lane must not start the scorer`).not.toContain("triggerInitialAiMatchWorker");
    }
    // Discovery's own write path schedules without starting a worker.
    const ingest = readFileSync(resolve(process.cwd(), "src/lib/sync/ingest.ts"), "utf8");
    expect(ingest).toContain("startWorker: false");
  });

  it("has no page-load, ApplicationSession, or legacy application-queue trigger", () => {
    const detailPage = readFileSync(resolve(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    const jobsRoute = readFileSync(resolve(process.cwd(), "src/app/api/jobs/route.ts"), "utf8");
    const worker = readFileSync(resolve(process.cwd(), "src/lib/matching/initialAiMatchQueue.ts"), "utf8");
    const scheduler = readFileSync(resolve(process.cwd(), "src/lib/sync/scheduler.ts"), "utf8");

    expect(detailPage).not.toContain("scheduleInitialAiMatch");
    expect(detailPage).not.toContain("triggerInitialAiMatchWorker");
    // The read path must never schedule. The marker follows the handler's
    // declaration style — it is now `export const POST = withUser(…)` — so
    // this still slices at the boundary between GET and POST rather than
    // silently measuring the whole file.
    const postAt = jobsRoute.indexOf("export const POST");
    expect(postAt).toBeGreaterThan(-1);
    expect(jobsRoute.slice(0, postAt)).not.toContain("scheduleInitialAiMatch(");
    expect(worker).not.toContain("ApplicationSession");
    expect(worker).not.toContain("applications/queue");
    expect(worker).not.toContain("application-worker");
    expect(scheduler).toContain("triggerInitialAiMatchWorker");
    expect(scheduler).not.toContain("queueJobsForMatching");
  });
});
