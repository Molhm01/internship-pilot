import { describe, expect, it } from "vitest";
import { normalizeCompanyMatchKey, scoreTitleSimilarity } from "./companyBoardResolver";

describe("companyBoardResolver matching helpers", () => {
  it("normalizes corporate suffixes cleanly", () => {
    expect(normalizeCompanyMatchKey("Lowe's Companies, Inc.")).toBe("lowe s");
    expect(normalizeCompanyMatchKey("T-Mobile")).toBe("t mobile");
    expect(normalizeCompanyMatchKey("Anduril Industries")).toBe("anduril industries");
  });

  it("matches equivalent internship titles across aggregator vs Workday/Greenhouse names", () => {
    const sim = scoreTitleSimilarity(
      "Summer 2027 AI Engineering Internship",
      "Summer 2027 Software Engineering AI Intern",
    );
    expect(sim).toBeGreaterThanOrEqual(0.5);

    const exact = scoreTitleSimilarity(
      "2027 Machine Learning Engineer Intern",
      "2027 Machine Learning Engineer Intern",
    );
    expect(exact).toBe(1);

    const unrelated = scoreTitleSimilarity(
      "Summer 2027 AI Engineering Internship",
      "Human Resources Business Partner Intern",
    );
    expect(unrelated).toBeLessThan(0.25);
  });
});
