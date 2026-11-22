import { describe, expect, it } from "vitest";
import { buildEffectiveMatchDescription, runGroundedHeuristicMatch } from "@/lib/matching";
import { correctAndValidateResumeContent, type ResumeClaimContent } from "@/lib/documents/claimValidation";
import { MASTER_ACTIVITIES, MASTER_EDUCATION, MASTER_EXPERIENCE, MASTER_PROJECTS, MASTER_SKILLS } from "@/lib/documents/masterResume";

const sampleFacts = [
  { id: "f1", type: "education", content: "New Jersey Institute of Technology", detail: "B.S. Electrical Engineering" },
  { id: "f2", type: "skill", content: "Python", detail: "Languages" },
  { id: "f3", type: "skill", content: "C++", detail: "Languages" },
  { id: "f4", type: "experience", content: "PC Builder and Repair Technician", detail: "Tested each system for stability before returning it to the client." },
  { id: "f5", type: "project", content: "Software-Defined Radio ADS-B Receiver", detail: "Python signal processing and demodulation." },
];

describe("100% immediate scoring & safe auto-sanitization", () => {
  it("synthesizes scoreable context for concise job listings with thin descriptions", () => {
    const effective = buildEffectiveMatchDescription({
      title: "Software Engineer Intern",
      company: "Databricks",
      location: "San Francisco, CA",
      workplaceType: "Hybrid",
      internshipTerm: "Summer 2027",
      source: "greenhouse",
      description: "",
    });
    expect(effective.length).toBeGreaterThanOrEqual(120);

    const result = runGroundedHeuristicMatch(
      sampleFacts,
      { title: "Software Engineer Intern", company: "Databricks", location: "San Francisco, CA", jobQualifications: null },
      effective,
    );
    expect(result.matchScore).toBeGreaterThanOrEqual(52);
    expect(result.matchScore).toBeLessThanOrEqual(100);
    expect(result.skillsToLearn.map((s) => s.skill)).not.toContain("Testing");
  });

  it("removes unsupported bullet phrases cleanly instead of blocking resume generation", () => {
    const resumeContent: ResumeClaimContent = {
      education: MASTER_EDUCATION.map((e) => ({ ...e })),
      experience: MASTER_EXPERIENCE.map((e) => ({ ...e, bullets: [...e.bullets] })),
      projects: MASTER_PROJECTS.map((p) => ({ ...p, bullets: [...p.bullets] })),
      skills: MASTER_SKILLS.map((g) => ({ ...g, items: [...g.items] })),
      activities: [...MASTER_ACTIVITIES],
    };

    const result = correctAndValidateResumeContent(
      resumeContent,
      ["Testing", "reliability testing"],
      [
        { id: "f1", content: "Python", detail: "Scripting" },
        { id: "f2", content: "B.S. Electrical Engineering", detail: "NJIT" },
        { id: "f3", content: "B.E. Computer Engineering", detail: "Stevens Institute of Technology" },
      ],
    );

    expect(result.unsupportedClaims).toEqual([]);
    expect(result.validationPasses).toBe(2);
    const firstExpBullets = result.content.experience[0]?.bullets ?? [];
    expect(firstExpBullets.some((b) => /Tested each system/i.test(b))).toBe(false);
  });
});
