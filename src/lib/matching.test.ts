import { beforeEach, describe, expect, it, vi } from "vitest";

const findJob = vi.fn();
const findFacts = vi.fn();
const createMatchResult = vi.fn();
const updateJob = vi.fn();
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

import { runMatchForJob } from "./matching";
import { OllamaError } from "./ollama";

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
    transaction.mockImplementation((operations: Promise<unknown>[]) => Promise.all(operations));
    logAudit.mockResolvedValue(undefined);
  });

  it("uses the selected job and approved profile facts, then persists the result", async () => {
    const result = await runMatchForJob(job.id);

    expect(findJob).toHaveBeenCalledWith({ where: { id: job.id } });
    expect(findFacts).toHaveBeenCalledWith({
      where: { status: { in: ["approved", "edited"] } },
      orderBy: { createdAt: "asc" },
    });
    const prompt = ollamaGenerateJSON.mock.calls[0][0] as string;
    expect(prompt).toContain("Firmware Intern");
    expect(prompt).toContain("Build embedded firmware");
    expect(prompt).toContain("[fact-python] (skill) Python");
    expect(createMatchResult).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        jobId: job.id,
        score: 82,
        factsUsed: JSON.stringify(["fact-python"]),
      }),
    }));
    expect(updateJob).toHaveBeenCalledWith({
      where: { id: job.id },
      data: { matchScore: 82, eligibilityStatus: "Pass" },
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ id: "match-1", jobId: job.id, score: 82 });
  });

  it("rejects a missing job description before reading facts or calling the model", async () => {
    findJob.mockResolvedValue({ ...job, description: "   " });

    await expect(runMatchForJob(job.id)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("usable job description"),
    });
    expect(findFacts).not.toHaveBeenCalled();
    expect(ollamaGenerateJSON).not.toHaveBeenCalled();
    expect(createMatchResult).not.toHaveBeenCalled();
  });

  it("returns a clear service error when the model fails without persisting anything", async () => {
    ollamaGenerateJSON.mockRejectedValue(new OllamaError("The local model failed."));

    await expect(runMatchForJob(job.id)).rejects.toMatchObject({
      status: 503,
      message: "The local model failed.",
    });
    expect(createMatchResult).not.toHaveBeenCalled();
    expect(updateJob).not.toHaveBeenCalled();
  });

  it("intentionally versions reruns by appending a new result each time", async () => {
    createMatchResult
      .mockResolvedValueOnce({ id: "match-v1", jobId: job.id, score: 82, eligibility: "Pass" })
      .mockResolvedValueOnce({ id: "match-v2", jobId: job.id, score: 82, eligibility: "Pass" });

    const first = await runMatchForJob(job.id);
    const second = await runMatchForJob(job.id);

    expect(first).toMatchObject({ id: "match-v1" });
    expect(second).toMatchObject({ id: "match-v2" });
    expect(createMatchResult).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
