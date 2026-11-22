import { describe, expect, it } from "vitest";
import { classifyField, lookupAnswer } from "./answerBank";
import type { FillContext } from "./types";

function makeContext(overrides: Partial<FillContext["profile"]> = {}): FillContext {
  return {
    jobId: "job-1",
    runId: "run-1",
    jobTitle: "Software Engineering Intern",
    company: "Acme Systems",
    applyUrl: "https://boards.greenhouse.io/acme/jobs/12345",
    mode: "auto_submit",
    profile: {
      fullName: "Samira Patel",
      legalFirstName: "Samira",
      legalMiddleName: "Neha",
      noMiddleName: false,
      legalLastName: "Patel",
      preferredName: "Samira Patel",
      pronouns: "she/her",
      email: "samira@university.edu",
      alternateEmail: "samira.alt@gmail.com",
      phone: "(973) 555-0194",
      phoneCountryCode: "+1",
      linkedin: "https://linkedin.com/in/samira-patel",
      github: "https://github.com/samirapatel",
      website: "https://samirapatel.dev",
      portfolio: "https://portfolio.samirapatel.dev",
      school: "New Jersey Institute of Technology",
      previousSchool: null,
      degreeType: "B.S. Computer Engineering",
      educationLevel: "Undergraduate",
      major: "Computer Engineering",
      minor: "Applied Mathematics",
      graduationDate: "2028-05",
      gpa: "3.88",
      addressStreet: "142 Market St",
      addressLine2: "Apt 4B",
      metroRegion: "NYC Metro Area",
      addressCity: "Newark",
      addressState: "NJ",
      addressZip: "07102",
      countryOfResidence: "United States",
      willingToRelocate: true,
      remotePreference: "hybrid",
      locationPreferences: ["New York, NY", "Remote"],
      earliestStartDate: "2026-06-01",
      internshipTermAvailability: "Summer 2026",
      salaryAnswerPreference: "Negotiable",
      workAuthorization: "U.S. Citizen",
      requiresSponsorship: false,
      clearanceEligible: false,
      securityClearanceStatus: "None",
      hasDriversLicense: true,
      meetsMinimumAge: true,
      referralSource: "Company Career Site",
      eeoGender: "Decline to self-identify",
      eeoRaceEthnicity: "Decline to self-identify",
      eeoVeteranStatus: "I am not a protected veteran",
      eeoDisabilityStatus: "I do not wish to answer",
      ...overrides,
    },
    educationDegree: "B.S. Computer Engineering",
    recentExperience: "Undergraduate Research Assistant — NJIT",
    resumeFilePath: "data/generated/resume.pdf",
    coverLetterFilePath: "data/generated/cover.pdf",
    coverLetterText: "I am excited to apply for the Software Engineering Intern role at Acme Systems.",
  };
}

describe("answerBank field classification & deterministic lookup", () => {
  it("resolves structured identity, contact, address line 2, and links accurately", () => {
    const ctx = makeContext();

    expect(lookupAnswer(ctx, "Legal First Name").value).toBe("Samira");
    expect(lookupAnswer(ctx, "Middle Name").value).toBe("Neha");
    expect(lookupAnswer(ctx, "Do you have no middle name?").value).toBe("No");
    expect(lookupAnswer(ctx, "Legal Last Name").value).toBe("Patel");
    expect(lookupAnswer(ctx, "Email Address *").value).toBe("samira@university.edu");
    expect(lookupAnswer(ctx, "Alternate Email").value).toBe("samira.alt@gmail.com");
    expect(lookupAnswer(ctx, "Phone Country Code").value).toBe("+1");
    expect(lookupAnswer(ctx, "Phone Number").value).toBe("(973) 555-0194");
    expect(lookupAnswer(ctx, "Street Address").value).toBe("142 Market St");
    expect(lookupAnswer(ctx, "Address Line 2").value).toBe("Apt 4B");
    expect(lookupAnswer(ctx, "City").value).toBe("Newark");
    expect(lookupAnswer(ctx, "State").value).toBe("NJ");
    expect(lookupAnswer(ctx, "Postal Code").value).toBe("07102");
    expect(lookupAnswer(ctx, "Metro Area").value).toBe("NYC Metro Area");
    expect(lookupAnswer(ctx, "Portfolio URL").value).toBe("https://portfolio.samirapatel.dev");
    expect(lookupAnswer(ctx, "Pronouns").value).toBe("she/her");
  });

  it("handles explicit noMiddleName=true cleanly without guessing", () => {
    const ctx = makeContext({ legalMiddleName: null, noMiddleName: true });
    expect(lookupAnswer(ctx, "Middle Name").value).toBe("N/A");
    expect(lookupAnswer(ctx, "Confirm no middle name").value).toBe("Yes");
  });

  it("resolves education details including GPA, major, minor, degree, and graduation month/year", () => {
    const ctx = makeContext();

    expect(classifyField("Cumulative GPA")).toBe("education");
    expect(lookupAnswer(ctx, "Cumulative GPA").value).toBe("3.88");
    expect(lookupAnswer(ctx, "Major / Field of Study").value).toBe("Computer Engineering");
    expect(lookupAnswer(ctx, "Minor").value).toBe("Applied Mathematics");
    expect(lookupAnswer(ctx, "Education Level").value).toBe("Undergraduate");
    expect(lookupAnswer(ctx, "Expected Graduation Year").value).toBe("2028");
    expect(lookupAnswer(ctx, "Expected Graduation Month").value).toBe("05");
    expect(lookupAnswer(ctx, "Graduation Date").value).toBe("2028-05");
  });

  it("resolves legal, citizenship, license, age, start date, and referral fields from explicit values", () => {
    const ctx = makeContext();

    expect(lookupAnswer(ctx, "Are you authorized to work in the United States?").value).toBe("Yes");
    expect(lookupAnswer(ctx, "Will you now or in the future require sponsorship?").value).toBe("No");
    expect(lookupAnswer(ctx, "Are you a U.S. Citizen?").value).toBe("Yes");
    expect(lookupAnswer(ctx, "Do you hold a valid driver's license?").value).toBe("Yes");
    expect(lookupAnswer(ctx, "Are you at least 18 years of age?").value).toBe("Yes");
    expect(lookupAnswer(ctx, "Earliest Start Date").value).toBe("2026-06-01");
    expect(lookupAnswer(ctx, "How did you hear about this position?").value).toBe("Company Career Site");
  });

  it("returns null rather than guessing when grounded profile values are absent", () => {
    const ctx = makeContext({
      gpa: null,
      graduationDate: null,
      hasDriversLicense: null,
      referralSource: null,
      workAuthorization: null,
      requiresSponsorship: null,
    });

    expect(lookupAnswer(ctx, "GPA").value).toBeNull();
    expect(lookupAnswer(ctx, "Graduation Year").value).toBeNull();
    expect(lookupAnswer(ctx, "Driver's license").value).toBeNull();
    expect(lookupAnswer(ctx, "How did you hear about us?").value).toBeNull();
    expect(lookupAnswer(ctx, "Do you require visa sponsorship?").value).toBeNull();
    expect(lookupAnswer(ctx, "Describe an unsolved systems challenge you debugged").value).toBeNull();
  });

  it("resolves Molhm Alasri contact, generic home address, phone, email, LinkedIn, and GitHub accurately", () => {
    const ctx = makeContext({
      fullName: "Molhm Alasri",
      legalFirstName: "Molhm",
      legalLastName: "Alasri",
      preferredName: "Molhm Alasri",
      email: "molhmalasri7@gmail.com",
      phone: "9292643117",
      addressStreet: "119 E 7th st",
      addressCity: "Clifton",
      addressState: "NJ",
      addressZip: "07011",
      linkedin: "https://www.linkedin.com/in/molhm-alasri/",
      github: "https://github.com/Molhm01",
    });

    expect(lookupAnswer(ctx, "Legal First Name").value).toBe("Molhm");
    expect(lookupAnswer(ctx, "Legal Last Name").value).toBe("Alasri");
    expect(lookupAnswer(ctx, "Full Name").value).toBe("Molhm Alasri");
    expect(lookupAnswer(ctx, "Email Address *").value).toBe("molhmalasri7@gmail.com");
    expect(lookupAnswer(ctx, "Phone Number").value).toBe("9292643117");
    expect(lookupAnswer(ctx, "Street Address").value).toBe("119 E 7th st");
    expect(lookupAnswer(ctx, "City").value).toBe("Clifton");
    expect(lookupAnswer(ctx, "State").value).toBe("NJ");
    expect(lookupAnswer(ctx, "Postal Code").value).toBe("07011");
    expect(lookupAnswer(ctx, "Home Address").value).toBe("119 E 7th st, Clifton, NJ 07011");
    expect(lookupAnswer(ctx, "LinkedIn URL").value).toBe("https://www.linkedin.com/in/molhm-alasri/");
    expect(lookupAnswer(ctx, "GitHub URL").value).toBe("https://github.com/Molhm01");
  });

  it("distinguishes current NJIT Electrical Engineering from transferred Stevens previousSchool", () => {
    const ctx = makeContext({
      school: "New Jersey Institute of Technology",
      previousSchool: "Stevens Institute of Technology",
      degreeType: "B.S. Electrical Engineering",
      major: "Electrical Engineering",
      graduationDate: "2029-05",
      gpa: null,
    });

    expect(lookupAnswer(ctx, "School").value).toBe("New Jersey Institute of Technology");
    expect(lookupAnswer(ctx, "Current University").value).toBe("New Jersey Institute of Technology");
    expect(lookupAnswer(ctx, "Major").value).toBe("Electrical Engineering");
    expect(lookupAnswer(ctx, "Degree").value).toBe("B.S. Electrical Engineering");
    expect(lookupAnswer(ctx, "Graduation Date").value).toBe("2029-05");
    expect(lookupAnswer(ctx, "Previous School").value).toBe("Stevens Institute of Technology");
    expect(lookupAnswer(ctx, "Transfer University").value).toBe("Stevens Institute of Technology");
  });
});
