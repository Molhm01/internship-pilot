import { describe, expect, it } from "vitest";
import { enforceGrounding, matchResponseSchema, type MatchResponse } from "./validation";

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
  it("rejects fractional scores and incomplete model arrays before persistence", () => {
    const fractional = result({ matchScore: 82.5 });
    const incomplete: Partial<MatchResponse> = { ...result() };
    delete incomplete.skillsNeverAdd;

    expect(matchResponseSchema.safeParse(fractional).success).toBe(false);
    expect(matchResponseSchema.safeParse(incomplete).success).toBe(false);
  });

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
        reason: "Supported by approved profile evidence.",
        factIds: ["fact-python"],
      },
    ]);
    expect(grounded.skillsNeedConfirmation.map((item) => item.skill)).not.toContain("Robotics leadership");
    expect(grounded.skillsNeverAdd.map((item) => item.skill)).toContain("Robotics leadership");
    expect(grounded.skillsToLearn[0].reason).toContain("no approved profile fact supports it");
    expect(grounded.explanation).toContain("Approved profile evidence supports: Python");
    expect(JSON.stringify(grounded)).not.toContain("Python used in an approved receiver project");
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

  it("never infers authorization, degrees, coursework, or quantified experience from weak overlap", () => {
    const grounded = enforceGrounding(
      result({
        skillsSupported: [
          { skill: "Python", reason: "Model claim", factIds: ["fact-python"] },
          { skill: "10 years Python experience", reason: "Model claim", factIds: ["fact-python"] },
          { skill: "Electrical Engineering degree", reason: "Model claim", factIds: ["fact-degree"] },
          { skill: "U.S. work authorization", reason: "Model claim", factIds: ["fact-work"] },
          { skill: "Digital Logic coursework", reason: "Model claim", factIds: ["fact-course"] },
        ],
      }),
      new Set(["fact-python", "fact-degree", "fact-work", "fact-course"]),
      new Map([
        ["fact-python", "Python used for receiver test automation"],
        ["fact-degree", "Bachelor of Science in Computer Engineering"],
        ["fact-work", "Worked on an approved receiver project"],
        ["fact-course", "Digital Logic"],
      ]),
      new Map([
        ["fact-python", "skill"],
        ["fact-degree", "education"],
        ["fact-work", "experience"],
        ["fact-course", "coursework"],
      ]),
    );

    expect(grounded.skillsSupported.map((item) => item.skill)).toEqual([
      "Python",
      "Digital Logic coursework",
    ]);
    expect(grounded.skillsNeedConfirmation).toEqual([]);
    expect(grounded.skillsNeverAdd.map((item) => item.skill)).toEqual(expect.arrayContaining([
      "10 years Python experience",
      "Electrical Engineering degree",
      "U.S. work authorization",
    ]));
    expect(JSON.stringify(grounded)).not.toContain("Model claim");
  });

  it("allows a supported related engineering degree without claiming an exact Civil Engineering degree", () => {
    const grounded = enforceGrounding(
      result({
        skillsSupported: [
          { skill: "related engineering degree", reason: "Model claim", factIds: ["fact-degree"] },
          { skill: "Civil Engineering degree", reason: "Model claim", factIds: ["fact-degree"] },
        ],
      }),
      new Set(["fact-degree"]),
      new Map([["fact-degree", "Bachelor of Science in Computer Engineering"]]),
      new Map([["fact-degree", "education"]]),
    );

    expect(grounded.skillsSupported.map((item) => item.skill)).toEqual(["related engineering degree"]);
    expect(grounded.skillsNeverAdd.map((item) => item.skill)).toContain("Civil Engineering degree");
    expect(grounded.skillsNeedConfirmation.map((item) => item.skill)).not.toContain("Civil Engineering degree");
  });
});
