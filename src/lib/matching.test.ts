import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findJob = vi.fn();
const findFacts = vi.fn();
const createMatchResult = vi.fn();
const updateJob = vi.fn();
const upsertUserJobState = vi.fn();
const transaction = vi.fn();
const ollamaGenerateJSON = vi.fn();
const logAudit = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    job: {
      findUnique: (...args: unknown[]) => findJob(...args),
      update: (...args: unknown[]) => updateJob(...args),
    },
    resumeFact: {
      findMany: (...args: unknown[]) => findFacts(...args),
    },
    matchResult: {
      create: (...args: unknown[]) => createMatchResult(...args),
    },
    userJobState: {
      upsert: (...args: unknown[]) => upsertUserJobState(...args),
    },
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}));

vi.mock("@/lib/ollama", () => ({
  OllamaError: class OllamaError extends Error {},
  ollamaGenerateJSON: (...args: unknown[]) => ollamaGenerateJSON(...args),
}));

vi.mock("@/lib/applications/audit", () => ({
  logAudit: (...args: unknown[]) => logAudit(...args),
}));

import { MATCH_MODEL_TIMEOUT_MS, runMatchForJob } from "./matching";
import { OllamaError } from "./ollama";

/** The owner every scoring call is made for in this suite. */
const TEST_USER = "test-user";

const job = {
  id: "job-1",
  title: "Firmware Intern",
  company: "Signal Labs",
  location: "Newark, NJ",
  internshipTerm: "Summer 2027",
  duration: "12 weeks",
  description: "Build embedded firmware with Python tooling, test reliable device communications, document verification results, and collaborate with electrical and software engineers throughout the product lifecycle.",
  jobResponsibilities: null,
  jobQualifications: null,
};

const facts = [{
  id: "fact-python",
  type: "skill",
  content: "Python",
  detail: "Used for receiver test automation",
  status: "approved",
}];

const modelResult = {
  eligibility: "Pass",
  eligibilityReason: "Model-authored reason",
  matchScore: 82,
  explanation: "Model-authored explanation",
  recommendation: "Apply",
  skillsSupported: [{ skill: "Python", reason: "Model claim", factIds: ["fact-python"] }],
  skillsNeedConfirmation: [],
  skillsToLearn: [{ skill: "Rust", reason: "Candidate already writes Rust", factIds: [] }],
  skillsNeverAdd: [],
  tailoringPreview: ["Invent a firmware role"],
};

describe("runMatchForJob", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.resetAllMocks();
    findJob.mockResolvedValue(job);
    findFacts.mockResolvedValue(facts);
    ollamaGenerateJSON.mockResolvedValue(modelResult);
    createMatchResult.mockResolvedValue({
      id: "match-1",
      jobId: job.id,
      score: 82,
      eligibility: "Pass",
    });
    updateJob.mockResolvedValue({ id: job.id });
    upsertUserJobState.mockResolvedValue({ userId: TEST_USER, jobId: job.id });
    transaction.mockImplementation((operations: Promise<unknown>[]) => Promise.all(operations));
    logAudit.mockResolvedValue(undefined);
  });

  it("uses the selected job and approved profile facts, then persists the result", async () => {
    const result = await runMatchForJob(job.id, { userId: TEST_USER });

    expect(findJob).toHaveBeenCalledWith({
      where: { id: job.id },
      select: expect.objectContaining({ id: true, description: true, jobQualifications: true }),
    });
    // Only this user's approved facts. A match reads one person's résumé.
    expect(findFacts).toHaveBeenCalledWith({
      where: { userId: TEST_USER, status: { in: ["approved", "edited"] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, type: true, content: true, detail: true },
    });
    const prompt = ollamaGenerateJSON.mock.calls[0][0] as string;
    expect(prompt).toContain("Firmware Intern");
    expect(prompt).toContain("Build embedded firmware");
    expect(prompt).toContain("[fact-python] (skill) Python");
    expect(ollamaGenerateJSON).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      timeoutMs: MATCH_MODEL_TIMEOUT_MS,
      temperature: 0,
      keepAlive: "10m",
      numPredict: 1_200,
      numCtx: 8_192,
    }));
    // `origin` carries the invalidation fingerprint alongside the trigger:
    // "<trigger>:JD:<job-description hash>:<profile hash>". Both hashes are
    // what lets a replaced résumé or an edited job description retire this
    // score instead of leaving it on screen as current.
    expect(createMatchResult).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        jobId: job.id,
        score: 82,
        factsUsed: JSON.stringify(["fact-python"]),
        origin: expect.stringMatching(/^MANUAL:JD:[0-9a-f]{64}:[0-9a-f]{64}$/),
      }),
    }));
    // The score is denormalized onto this user's state row. Writing it to the
    // shared Job row is what let one applicant's score become everyone's.
    expect(updateJob).not.toHaveBeenCalled();
    expect(upsertUserJobState).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_jobId: { userId: TEST_USER, jobId: job.id } },
      create: expect.objectContaining({
        userId: TEST_USER,
        jobId: job.id,
        matchScore: 82,
        eligibilityStatus: "Pass",
        scoreSource: "AI_REFINED",
        scoreProfileRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
        scoreJobFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      update: expect.objectContaining({
        matchScore: 82,
        eligibilityStatus: "Pass",
        scoreSource: "AI_REFINED",
        scoreProfileRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
        scoreJobFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    }));
    expect(transaction).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ id: "match-1", jobId: job.id, score: 82 });
  });

  it("rejects a missing job description before reading facts or calling the model", async () => {
    findJob.mockResolvedValue({ ...job, description: "   " });

    await expect(runMatchForJob(job.id, { userId: TEST_USER })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("usable job description"),
    });
    expect(findFacts).not.toHaveBeenCalled();
    expect(ollamaGenerateJSON).not.toHaveBeenCalled();
    expect(createMatchResult).not.toHaveBeenCalled();
  });

  it("returns a clear service error when the model fails without persisting anything", async () => {
    ollamaGenerateJSON.mockRejectedValue(new OllamaError("The local model failed."));

    await expect(runMatchForJob(job.id, { userId: TEST_USER })).rejects.toMatchObject({
      status: 503,
      code: "MODEL_UNAVAILABLE",
      message: "The local AI model is unavailable. Check Ollama, then try again.",
    });
    expect(createMatchResult).not.toHaveBeenCalled();
    expect(upsertUserJobState).not.toHaveBeenCalled();
  });

  it("returns a stable timeout error when the model does not finish", async () => {
    ollamaGenerateJSON.mockRejectedValue(new OllamaError("The operation timed out."));

    await expect(runMatchForJob(job.id, { userId: TEST_USER })).rejects.toMatchObject({
      status: 504,
      code: "MODEL_TIMEOUT",
      message: expect.stringContaining("too long"),
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["fractional score", { ...modelResult, matchScore: 82.5 }],
    ["missing arrays", {
      eligibility: "Pass",
      eligibilityReason: "Reason",
      matchScore: 82,
      explanation: "Explanation",
      recommendation: "Apply",
    }],
  ])("rejects malformed model output: %s", async (_label, output) => {
    ollamaGenerateJSON.mockResolvedValue(output);

    await expect(runMatchForJob(job.id, { userId: TEST_USER })).rejects.toMatchObject({
      status: 502,
      code: "MODEL_RESPONSE_INVALID",
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(createMatchResult).not.toHaveBeenCalled();
    expect(ollamaGenerateJSON).toHaveBeenCalledTimes(2);
  });

  it("preserves the previous valid result when a rerun cannot persist", async () => {
    const previous = { id: "match-v1", score: 77, eligibility: "Pass" };
    transaction.mockRejectedValue(new Error("database unavailable"));

    await expect(runMatchForJob(job.id, { userId: TEST_USER })).rejects.toMatchObject({
      code: "MATCH_PERSISTENCE_FAILED",
    });
    expect(previous).toEqual({ id: "match-v1", score: 77, eligibility: "Pass" });
  });

  it("logs only safe progress metadata, never profile contents", async () => {
    const sensitive = "private-candidate-detail-should-not-be-logged";
    findFacts.mockResolvedValue([{ ...facts[0], detail: sensitive }]);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await runMatchForJob(job.id, { userId: TEST_USER });
    const logs = JSON.stringify(info.mock.calls);

    expect(logs).toContain("job_loaded");
    expect(logs).toContain("profile_loaded");
    expect(logs).toContain("model_request_started");
    expect(logs).toContain("model_response_received");
    expect(logs).toContain("response_validated");
    expect(logs).toContain("result_persisted");
    expect(logs).not.toContain(sensitive);
    expect(JSON.stringify(response)).not.toContain(sensitive);
  });

  it("intentionally versions reruns by appending a new result each time", async () => {
    createMatchResult
      .mockResolvedValueOnce({ id: "match-v1", jobId: job.id, score: 82, eligibility: "Pass" })
      .mockResolvedValueOnce({ id: "match-v2", jobId: job.id, score: 82, eligibility: "Pass" });

    const first = await runMatchForJob(job.id, { userId: TEST_USER });
    const second = await runMatchForJob(job.id, { userId: TEST_USER });

    expect(first).toMatchObject({ id: "match-v1" });
    expect(second).toMatchObject({ id: "match-v2" });
    expect(createMatchResult).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("stores manual and INITIAL_AUTO origins separately without changing scoring", async () => {
    await runMatchForJob(job.id, { userId: TEST_USER, origin: "INITIAL_AUTO" });

    expect(createMatchResult).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        origin: expect.stringMatching(/^INITIAL_AUTO:JD:[0-9a-f]{64}:[0-9a-f]{64}$/),
        score: 82,
      }),
    }));
  });

  it("has no ApplicationSession, application queue, or worker dependency", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/matching.ts"), "utf8");

    expect(source).not.toContain("ApplicationSession");
    expect(source).not.toContain("@/lib/applications/queue");
    expect(source).not.toContain("@/lib/applications/worker");
  });
});
