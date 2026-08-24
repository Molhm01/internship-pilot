import { describe, expect, it } from "vitest";
import { documentFingerprintFromInputs, type DocumentFingerprintInputs } from "./documentFingerprint";
import { reusableApplicationDocuments } from "./applicationReadiness";

function inputs(): DocumentFingerprintInputs {
  return {
    websiteJobId: "job-1",
    jobDescription: "Build accessible React application forms.",
    approvedProfile: { updatedAt: "2026-08-23", legalName: "Riley Fixture" },
    approvedFacts: [{ id: "fact-1", content: "Built React forms" }],
    latestMatch: { id: "match-1", score: 91, neverAdd: ["Kubernetes"] },
    masterResumeRevision: { template: "template-v1", resume: "resume-v1" },
    generationPolicyRevision: "policy-v1",
  };
}

describe("application document fingerprint", () => {
  it("is deterministic for the same inputs", () => {
    expect(documentFingerprintFromInputs(inputs())).toBe(documentFingerprintFromInputs(inputs()));
  });

  it.each([
    ["changed JD", { jobDescription: "Build Workday integrations." }],
    ["changed approved facts", { approvedFacts: [{ id: "fact-2", content: "Built Lever integrations" }] }],
    ["changed profile", { approvedProfile: { updatedAt: "2026-08-24", legalName: "Riley Fixture" } }],
    ["changed match", { latestMatch: { id: "match-2", score: 92 } }],
    ["changed template", { masterResumeRevision: { template: "template-v2", resume: "resume-v1" } }],
    ["changed policy", { generationPolicyRevision: "policy-v2" }],
  ])("invalidates for %s", (_label, change) => {
    expect(documentFingerprintFromInputs({ ...inputs(), ...change })).not.toBe(documentFingerprintFromInputs(inputs()));
  });
});

describe("document reuse guard", () => {
  const fingerprint = "a".repeat(64);
  const base = {
    jobId: "job-1", userId: "user-1", type: "resume", version: 1,
    qaStatus: "pass", identityVerified: true, documentFingerprint: fingerprint,
  };

  it("reuses the newest matching QA-passed job document", () => {
    const selected = reusableApplicationDocuments([{ ...base }, { ...base, version: 2 }], {
      jobId: "job-1", userId: "user-1", fingerprint, includeCoverLetter: false,
    });
    expect(selected?.[0]?.version).toBe(2);
  });

  it("never reuses failed QA, stale, unverified, wrong-job, or wrong-user documents", () => {
    const invalid = [
      { ...base, qaStatus: "fail" },
      { ...base, documentFingerprint: "b".repeat(64) },
      { ...base, identityVerified: false },
      { ...base, jobId: "job-2" },
      { ...base, userId: "user-2" },
    ];
    expect(reusableApplicationDocuments(invalid, {
      jobId: "job-1", userId: "user-1", fingerprint, includeCoverLetter: false,
    })).toBeNull();
  });

  it("requires a current cover letter when requested", () => {
    expect(reusableApplicationDocuments([{ ...base }], {
      jobId: "job-1", userId: "user-1", fingerprint, includeCoverLetter: true,
    })).toBeNull();
    expect(reusableApplicationDocuments([{ ...base }, { ...base, type: "coverLetter" }], {
      jobId: "job-1", userId: "user-1", fingerprint, includeCoverLetter: true,
    })).toHaveLength(2);
  });
});
