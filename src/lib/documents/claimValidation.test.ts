import { describe, expect, it } from "vitest";
import {
  correctAndValidateResumeContent,
  isQualificationSupportedByFacts,
  validateUnsupportedClaims,
  type ResumeClaimContent,
} from "./claimValidation";

const approvedFacts = [
  { id: "sensor", content: "Air Quality Monitor", detail: "Sampled and filtered MQ-135 sensor data." },
  { id: "repair", content: "PC repair", detail: "Tested each system for stability before returning it to the client." },
  { id: "diagnostics", content: "Hardware repair", detail: "Diagnosed and tested desktop hardware failures." },
];

const content = (): ResumeClaimContent => ({
  education: [{ school: "NJIT", degree: "B.S. Electrical Engineering", coursework: "Digital Design", location: "Newark, NJ", dates: "Expected May 2029" }],
  experience: [{ title: "Technician", organization: "Freelance", location: "NJ", dates: "2021 – Present", bullets: ["Diagnosed desktop hardware failures."] }],
  projects: [{ title: "Sensor Monitor", organization: "", location: "", dates: "", bullets: ["Sampled and filtered MQ-135 sensor data."] }],
  skills: [{ label: "Additional", items: ["real-time data acquisition", "reliability testing", "diagnostics"] }],
  activities: ["IEEE — Member"],
});

describe("tailored-document unsupported-claim correction", () => {
  it("removes unsupported job wording, reruns validation, and keeps grounded replacements", () => {
    const result = correctAndValidateResumeContent(
      content(),
      ["real-time data acquisition", "reliability testing"],
      approvedFacts,
    );
    const skills = result.content.skills.flatMap((group) => group.items);

    expect(result.validationPasses).toBe(2);
    expect(result.unsupportedClaims).toEqual([]);
    expect(result.correctedClaims.map((claim) => claim.phrase)).toEqual([
      "real-time data acquisition",
      "reliability testing",
    ]);
    expect(skills).not.toContain("real-time data acquisition");
    expect(skills).not.toContain("reliability testing");
    expect(skills).toEqual(expect.arrayContaining(["sensor data sampling", "system stability testing", "diagnostics"]));
  });

  it("accepts semantic wording only when every concept is grounded in one approved fact", () => {
    expect(isQualificationSupportedByFacts("diagnostic testing", approvedFacts)).toBe(true);
    expect(isQualificationSupportedByFacts("sensor data sampling", approvedFacts)).toBe(true);
    expect(isQualificationSupportedByFacts("real-time data acquisition", approvedFacts)).toBe(false);
    expect(isQualificationSupportedByFacts("reliability testing", approvedFacts)).toBe(false);
  });

  it("distinguishes a missing job requirement from a candidate claim", () => {
    const details = validateUnsupportedClaims([
      { sourceSection: "Gap summary", text: "The job requests reliability testing, which is not supported by the profile.", context: "job_requirement" },
      { sourceSection: "Skills", text: "Reliability testing", context: "candidate" },
      { sourceSection: "Role title", text: "Reliability Testing Intern", context: "ordinary" },
    ], ["reliability testing"], approvedFacts);

    expect(details).toEqual([expect.objectContaining({
      phrase: "reliability testing",
      sourceSection: "Skills",
      sentence: "Reliability testing",
    })]);
  });

  it("leaves an irremovable fabricated credential as a structured blocking claim", () => {
    const unsafe = content();
    unsafe.education[0].degree = "B.S. Civil Engineering degree";
    const result = correctAndValidateResumeContent(
      unsafe,
      ["Civil Engineering degree"],
      approvedFacts,
    );

    expect(result.validationPasses).toBe(2);
    expect(result.unsupportedClaims).toEqual([expect.objectContaining({
      phrase: "Civil Engineering degree",
      sourceSection: "Education 1 degree",
      reason: expect.stringContaining("no approved profile fact"),
    })]);
  });
});
