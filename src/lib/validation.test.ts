import { describe, expect, it } from "vitest";
import { enforceGrounding, type MatchResponse } from "./validation";

function result(overrides: Partial<MatchResponse> = {}): MatchResponse {
  return {
    eligibility: "Pass",
    eligibilityReason: "The candidate has ten years of robotics experience.",
    matchScore: 80,
    explanation: "The candidate managed a robotics laboratory for ten years.",
    recommendation: "Apply",
    skillsSupported: [],
    skillsNeedConfirmation: [],
    skillsToLearn: [],
    skillsNeverAdd: [],
    tailoringPreview: ["Add ten years of robotics leadership."],
    ...overrides,
  };
}

describe("AI Match grounding", () => {
  it("keeps only supported qualifications with real overlapping approved facts", () => {
    const grounded = enforceGrounding(
      result({
        skillsSupported: [
          { skill: "Python", reason: "Model claim", factIds: ["fact-python"] },
          { skill: "Robotics leadership", reason: "Model claim", factIds: ["invented"] },
        ],
        skillsToLearn: [
          { skill: "Rust", reason: "The candidate has shipped production Rust", factIds: [] },
        ],
      }),
      new Set(["fact-python"]),
      new Map([["fact-python", "Python used in an approved receiver project"]]),
    );

    expect(grounded.skillsSupported).toEqual([
      {
        skill: "Python",
        reason: "Supported by approved profile evidence: Python used in an approved receiver project.",
        factIds: ["fact-python"],
      },
    ]);
    expect(grounded.skillsNeedConfirmation.map((item) => item.skill)).toContain("Robotics leadership");
    expect(grounded.skillsToLearn[0].reason).toContain("no approved profile fact supports it");
    expect(grounded.explanation).toContain("Python used in an approved receiver project");
    expect(JSON.stringify(grounded)).not.toContain("managed a robotics laboratory");
    expect(JSON.stringify(grounded)).not.toContain("ten years of robotics leadership");
    expect(JSON.stringify(grounded)).not.toContain("shipped production Rust");
  });

  it("forces Fail eligibility to Skip", () => {
    expect(enforceGrounding(
      result({ eligibility: "Fail", recommendation: "Apply" }),
      new Set(),
      new Map(),
    ).recommendation).toBe("Skip");
  });
});
