import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __clearLongAnswerCacheForTests,
  classifyEssayQuestion,
  generateLongAnswer,
  type LongAnswerFacts,
} from "./longAnswer";

const baseFacts: LongAnswerFacts = {
  jobTitle: "Software Engineering Intern",
  company: "Northbridge Analytics Group",
  jobDescription: "Build internal tooling in TypeScript and Go. Requires teamwork and Python.",
  school: "Verification State University",
  degree: "B.S. Computer Science",
  experiences: [
    { employer: "Verify Labs LLC", title: "Software Engineering Intern", approvedBullets: ["Led a 3-person team migrating CI to a new pipeline", "Wrote Python data pipelines"] },
  ],
  projects: [
    { name: "Embedded Sensor Controller", description: "A personal project wiring a microcontroller to sensors.", approvedSkills: ["C", "embedded systems"] },
  ],
  willingToRelocate: null,
  internshipTermAvailability: null,
  workAuthorization: null,
  requiresSponsorship: null,
  companyRelationship: null,
};

describe("classifyEssayQuestion", () => {
  it.each([
    ["Why do you want to work here?", "why_company"],
    ["Why this company?", "why_company"],
    ["Why are you interested in this role?", "why_role"],
    ["What interests you about this position?", "why_role"],
    ["Describe a relevant project you have worked on.", "project"],
    ["Tell us about a leadership experience.", "leadership"],
    ["Describe a time you worked in a team.", "leadership"],
    ["What technical interest do you have in this field?", "technical_interest"],
    ["Please explain your relocation situation.", "relocation_explanation"],
    ["Please describe your availability to start.", "availability_explanation"],
    ["Please explain your work authorization status.", "authorization_explanation"],
    ["Please explain your sponsorship needs.", "sponsorship_explanation"],
    ["Do you have a relative who works at this company?", "referral_family"],
    ["Were you referred to this position?", "referral_family"],
  ] as const)("classifies %j as %s", (label, expected) => {
    expect(classifyEssayQuestion(label)).toBe(expected);
  });

  it("returns null for a question that isn't an essay category", () => {
    expect(classifyEssayQuestion("What is your favorite color?")).toBeNull();
  });
});

describe("generateLongAnswer — structured categories (no LLM)", () => {
  const neverCalledLlm = vi.fn();
  beforeEach(() => {
    __clearLongAnswerCacheForTests();
    neverCalledLlm.mockClear();
  });

  it("relocation: answers Yes when willingToRelocate is true", async () => {
    const result = await generateLongAnswer("relocation_explanation", "job-1", { ...baseFacts, willingToRelocate: true }, neverCalledLlm);
    expect(result).toEqual({ answer: "Yes, I am willing to relocate for this opportunity.", source: "structured" });
    expect(neverCalledLlm).not.toHaveBeenCalled();
  });

  it("relocation: pauses (null) when unknown", async () => {
    const result = await generateLongAnswer("relocation_explanation", "job-1", baseFacts, neverCalledLlm);
    expect(result.answer).toBeNull();
  });

  it("availability: answers from internshipTermAvailability", async () => {
    const result = await generateLongAnswer("availability_explanation", "job-1", { ...baseFacts, internshipTermAvailability: "June 2027" }, neverCalledLlm);
    expect(result.answer).toBe("I am available starting June 2027.");
  });

  it("authorization: answers verbatim from the stored explanation", async () => {
    const result = await generateLongAnswer("authorization_explanation", "job-1", { ...baseFacts, workAuthorization: "Authorized to work in the United States without sponsorship." }, neverCalledLlm);
    expect(result.answer).toBe("Authorized to work in the United States without sponsorship.");
  });

  it("sponsorship: answers Yes/No from requiresSponsorship", async () => {
    const yes = await generateLongAnswer("sponsorship_explanation", "job-1", { ...baseFacts, requiresSponsorship: true }, neverCalledLlm);
    expect(yes.answer).toBe("I will require visa sponsorship to work in this role.");
    const no = await generateLongAnswer("sponsorship_explanation", "job-1", { ...baseFacts, requiresSponsorship: false }, neverCalledLlm);
    expect(no.answer).toBe("I do not require visa sponsorship to work in this role.");
  });

  it("referral_family: pauses (null) when nothing is known — never guesses", async () => {
    const result = await generateLongAnswer("referral_family", "job-1", baseFacts, neverCalledLlm);
    expect(result.answer).toBeNull();
    expect(neverCalledLlm).not.toHaveBeenCalled();
  });

  it("referral_family: answers from a known referral", async () => {
    const facts: LongAnswerFacts = {
      ...baseFacts,
      companyRelationship: { hasReferral: true, referralName: "Jordan Lee", referralRelationship: "former colleague", familyMemberEmployed: null },
    };
    const result = await generateLongAnswer("referral_family", "job-1", facts, neverCalledLlm);
    expect(result.answer).toContain("Jordan Lee");
    expect(neverCalledLlm).not.toHaveBeenCalled();
  });

  it("referral_family: answers explicit No when both are explicitly false", async () => {
    const facts: LongAnswerFacts = {
      ...baseFacts,
      companyRelationship: { hasReferral: false, referralName: null, referralRelationship: null, familyMemberEmployed: false },
    };
    const result = await generateLongAnswer("referral_family", "job-1", facts, neverCalledLlm);
    expect(result.answer).toMatch(/^No/);
  });
});

describe("generateLongAnswer — LLM categories", () => {
  beforeEach(() => __clearLongAnswerCacheForTests());

  it("why_company: uses the model's grounded answer when answerable", async () => {
    const fakeLlm = vi.fn().mockResolvedValue({ answerable: true, answer: "I'm drawn to Northbridge's focus on internal tooling." });
    const result = await generateLongAnswer("why_company", "job-1", baseFacts, fakeLlm);
    expect(result).toEqual({ answer: "I'm drawn to Northbridge's focus on internal tooling.", source: "llm" });
    expect(fakeLlm).toHaveBeenCalledTimes(1);
  });

  it("project: pauses when the model reports insufficient evidence", async () => {
    const fakeLlm = vi.fn().mockResolvedValue({ answerable: false, answer: "" });
    const result = await generateLongAnswer("project", "job-1", baseFacts, fakeLlm);
    expect(result.answer).toBeNull();
  });

  it("leadership: pauses (never fabricates) when the model call fails", async () => {
    const fakeLlm = vi.fn().mockRejectedValue(new Error("Ollama unreachable"));
    const result = await generateLongAnswer("leadership", "job-1", baseFacts, fakeLlm);
    expect(result.answer).toBeNull();
  });

  it("technical_interest: an answerable:true with an empty answer string still pauses", async () => {
    const fakeLlm = vi.fn().mockResolvedValue({ answerable: true, answer: "" });
    const result = await generateLongAnswer("technical_interest", "job-1", baseFacts, fakeLlm);
    expect(result.answer).toBeNull();
  });

  it("caches a successful generation per (jobId, category) so the model is not called twice", async () => {
    const fakeLlm = vi.fn().mockResolvedValue({ answerable: true, answer: "Grounded answer." });
    await generateLongAnswer("why_role", "job-1", baseFacts, fakeLlm);
    await generateLongAnswer("why_role", "job-1", baseFacts, fakeLlm);
    expect(fakeLlm).toHaveBeenCalledTimes(1);
  });

  it("does NOT reuse a cached why_company answer across a different job (company-specific, never leaked)", async () => {
    const fakeLlm = vi.fn().mockResolvedValue({ answerable: true, answer: "Answer for job 1." });
    await generateLongAnswer("why_company", "job-1", baseFacts, fakeLlm);
    await generateLongAnswer("why_company", "job-2", { ...baseFacts, company: "A Different Company" }, fakeLlm);
    expect(fakeLlm).toHaveBeenCalledTimes(2);
  });
});
