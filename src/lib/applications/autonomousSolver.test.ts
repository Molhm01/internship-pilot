import { describe, expect, it } from "vitest";
import {
  DEFAULT_PORTAL_EMAIL,
  DEFAULT_PORTAL_PASSWORD,
  generatePortalCredentials,
  pickAutonomousOption,
  resolveAutonomousFieldAnswer,
} from "./autonomousSolver";
import type { FillContext } from "./types";

function makeSparseContext(overrides: Partial<FillContext> = {}): FillContext {
  return {
    jobId: "job-1",
    runId: "run-12345",
    jobTitle: "Software Engineering Intern",
    company: "Stripe",
    applyUrl: "https://boards.greenhouse.io/stripe/jobs/123",
    mode: "auto_submit",
    profile: {
      fullName: "Samira Pilot",
      legalFirstName: "Samira",
      legalLastName: "Pilot",
      legalMiddleName: null,
      noMiddleName: true,
      preferredName: null,
      email: "samira@test.dev",
      alternateEmail: null,
      phone: "555-019-2834",
      phoneCountryCode: "+1",
      addressStreet: null,
      addressLine2: null,
      addressCity: null,
      addressState: null,
      addressZip: null,
      countryOfResidence: null,
      metroRegion: null,
      linkedin: "https://linkedin.com/in/samira",
      github: "https://github.com/samira",
      portfolio: null,
      website: null,
      school: "University of Michigan",
      degreeType: "B.S.",
      educationLevel: "Bachelor's",
      major: "Computer Science",
      minor: null,
      gpa: "3.9",
      graduationDate: "2027-05",
      earliestStartDate: null,
      internshipTermAvailability: null,
      workAuthorization: null,
      requiresSponsorship: null,
      securityClearanceStatus: null,
      clearanceEligible: null,
      meetsMinimumAge: null,
      hasDriversLicense: null,
      willingToRelocate: null,
      remotePreference: null,
      eeoGender: null,
      eeoRaceEthnicity: null,
      eeoVeteranStatus: null,
      eeoDisabilityStatus: null,
      pronouns: null,
      referralSource: null,
      salaryAnswerPreference: null,
      previousSchool: null,
      locationPreferences: null,
    },
    resumeFilePath: "data/generated/resume.pdf",
    coverLetterFilePath: "data/generated/cover.pdf",
    coverLetterText: null,
    educationDegree: "B.S. Computer Science",
    recentExperience: "Backend Engineering Intern at FinCore",
    approvedRunAnswers: {},
    ...overrides,
  };
}

describe("autonomousSolver zero-stop resolution", () => {
  it("resolves terms checkboxes, EEO dropdowns, work authorization, and essays without returning null", () => {
    const ctx = makeSparseContext();

    const terms = resolveAutonomousFieldAnswer(ctx, {}, "I certify all information is accurate", {
      type: "checkbox",
      tag: "input",
    });
    expect(terms.value).toBe("Yes");

    const gender = resolveAutonomousFieldAnswer(ctx, {}, "Gender (voluntary self-identification)", {
      type: "select",
      tag: "select",
      options: ["Select...", "Male", "Female", "Decline to self-identify"],
    });
    expect(gender.value).toBe("Decline to self-identify");

    const sponsor = resolveAutonomousFieldAnswer(ctx, {}, "Will you now or in the future require sponsorship?", {
      type: "radio",
      tag: "input",
      options: ["Yes", "No"],
    });
    expect(sponsor.value).toBe("No");

    const essay = resolveAutonomousFieldAnswer(ctx, {}, "Why are you interested in Stripe?", {
      type: "textarea",
      tag: "textarea",
    });
    expect(essay.value).toContain("Stripe");
    expect(essay.value.length).toBeGreaterThan(30);
  });

  it("matches options cleanly including aliases, US state abbreviations, and non-placeholder fallbacks", () => {
    const country = pickAutonomousOption("United States", ["Select...", "Canada", "USA", "UK"], "country");
    expect(country?.label).toBe("USA");

    const state = pickAutonomousOption("NJ", ["Select...", "New Hampshire", "New Jersey", "New York"], "state");
    expect(state?.label).toBe("New Jersey");

    const eeo = pickAutonomousOption(
      "Decline to self-identify",
      ["Select...", "Yes", "I do not wish to disclose"],
      "eeo",
    );
    expect(eeo?.label).toBe("I do not wish to disclose");
  });

  it("generates user-configured portal credentials with default Molhmiscool21! password", () => {
    expect(DEFAULT_PORTAL_EMAIL).toBe("mjalasri1@gmail.com");
    expect(DEFAULT_PORTAL_PASSWORD).toBe("Molhmiscool21!");

    const creds = generatePortalCredentials("samira@test.dev", "Acme Robotics", "Samira Pilot");
    expect(creds.email).toBe("samira@test.dev");
    expect(creds.password).toBe("Molhmiscool21!");
    expect(creds.firstName).toBe("Samira");
    expect(creds.lastName).toBe("Pilot");

    const custom = generatePortalCredentials(null, "Microsoft", "Molhm Alasri", "CustomPass99!");
    expect(custom.email).toBe("mjalasri1@gmail.com");
    expect(custom.password).toBe("CustomPass99!");
    expect(custom.firstName).toBe("Molhm");
    expect(custom.lastName).toBe("Alasri");
  });
});
