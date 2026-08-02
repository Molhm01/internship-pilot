import { describe, expect, it } from "vitest";
import { classifyInternship, isQualifying, isReviewable } from "@/lib/sync/internshipClassifier";

const c = (title: string, description = "", employmentType = "") =>
  classifyInternship({ title, description, employmentType }).classification;

describe("classifyInternship — qualifying", () => {
  it("accepts explicit intern titles", () => {
    expect(c("Software Engineer Intern")).toBe("QUALIFYING_INTERNSHIP");
    expect(c("Internship, Mechanical Engineering")).toBe("QUALIFYING_INTERNSHIP");
    expect(c("2027 Summer Interns - Robotics")).toBe("QUALIFYING_INTERNSHIP");
  });

  it("accepts co-op spellings", () => {
    expect(c("Electrical Engineering Co-op")).toBe("QUALIFYING_INTERNSHIP");
    expect(c("Manufacturing Coop - Fall 2026")).toBe("QUALIFYING_INTERNSHIP");
    expect(c("Cooperative Education Student")).toBe("QUALIFYING_INTERNSHIP");
  });

  it("accepts student trainee and apprenticeship titles", () => {
    expect(c("Student Trainee (Engineering)")).toBe("QUALIFYING_INTERNSHIP");
    expect(c("Engineering Apprentice")).toBe("QUALIFYING_INTERNSHIP");
  });

  it("accepts internship employment-type metadata even when the title is silent", () => {
    expect(c("Data Platform Engineer", "", "Internship")).toBe("QUALIFYING_INTERNSHIP");
  });

  it("reads the vendors' actual employmentType spellings", () => {
    // Ashby emits "Intern"/"FullTime"; Lever emits "Intern"/"Full-time".
    expect(c("Data Platform Engineer", "", "Intern")).toBe("QUALIFYING_INTERNSHIP");
    expect(c("Data Platform Engineer", "", "FullTime")).toBe("NOT_AN_INTERNSHIP");
    expect(c("Data Platform Engineer", "", "Full-time")).toBe("NOT_AN_INTERNSHIP");
  });

  it("keeps an internship whose title also mentions a senior team", () => {
    // The seniority word describes the team, not the hire.
    expect(c("Intern, Senior Data Platform Team")).toBe("QUALIFYING_INTERNSHIP");
  });
});

describe("classifyInternship — the 'internal' trap", () => {
  it("does not treat 'internal' or 'international' as an internship", () => {
    expect(c("Internal Audit Manager")).toBe("NOT_AN_INTERNSHIP");
    expect(c("International Logistics Coordinator")).toBe("NOT_AN_INTERNSHIP");
    expect(c("Internal Communications Lead")).toBe("NOT_AN_INTERNSHIP");
  });
});

describe("classifyInternship — exclusions", () => {
  it("excludes senior, lead, and management roles", () => {
    expect(c("Senior Software Engineer")).toBe("NOT_AN_INTERNSHIP");
    expect(c("Staff Mechanical Engineer")).toBe("NOT_AN_INTERNSHIP");
    expect(c("Engineering Manager")).toBe("NOT_AN_INTERNSHIP");
    expect(c("Director of Platform")).toBe("NOT_AN_INTERNSHIP");
  });

  it("excludes leveled experienced titles", () => {
    expect(c("Software Engineer III")).toBe("NOT_AN_INTERNSHIP");
  });

  it("excludes postings demanding multiple years of experience", () => {
    expect(c("Systems Engineer", "Requires 5+ years of relevant experience.")).toBe("NOT_AN_INTERNSHIP");
  });

  it("excludes explicit full-time employment type", () => {
    expect(c("Product Engineer", "", "Full-time")).toBe("NOT_AN_INTERNSHIP");
  });

  it("marks closed postings as CONFIRMED_CLOSED, not as non-internships", () => {
    expect(c("Software Engineer Intern", "This role is no longer accepting applications.")).toBe(
      "CONFIRMED_CLOSED",
    );
    expect(classifyInternship({ title: "Hardware Intern", closed: true }).classification).toBe(
      "CONFIRMED_CLOSED",
    );
  });
});

describe("classifyInternship — uncertain records stay reviewable", () => {
  it("treats a bare summer analyst title as uncertain", () => {
    expect(c("Summer Analyst")).toBe("UNCERTAIN_CLASSIFICATION");
  });

  it("promotes a summer analyst title with student context", () => {
    expect(c("Summer Analyst", "Open to rising seniors currently enrolled in a BS program.")).toBe(
      "QUALIFYING_INTERNSHIP",
    );
  });

  it("treats description-only internship language as uncertain, never as a drop", () => {
    const result = classifyInternship({
      title: "Engineering Program Associate",
      description: "Our interns work alongside this team each summer.",
    });
    expect(result.classification).toBe("UNCERTAIN_CLASSIFICATION");
    expect(isReviewable(result.classification)).toBe(true);
  });
});

describe("classifyInternship — malformed input", () => {
  it("reports PARSE_FAILED rather than throwing on a missing title", () => {
    expect(classifyInternship({ title: "", description: "x" }).classification).toBe("PARSE_FAILED");
    expect(classifyInternship({}).classification).toBe("PARSE_FAILED");
    expect(classifyInternship({ title: null, description: null }).classification).toBe("PARSE_FAILED");
  });
});

describe("classification helpers", () => {
  it("only QUALIFYING_INTERNSHIP is publishable", () => {
    expect(isQualifying("QUALIFYING_INTERNSHIP")).toBe(true);
    expect(isQualifying("UNCERTAIN_CLASSIFICATION")).toBe(false);
    expect(isQualifying("NOT_AN_INTERNSHIP")).toBe(false);
  });

  it("every classification carries a non-empty reason", () => {
    const samples = ["Software Engineer Intern", "Senior Engineer", "Summer Analyst", ""];
    for (const title of samples) {
      expect(classifyInternship({ title }).reason.length).toBeGreaterThan(0);
    }
  });
});
