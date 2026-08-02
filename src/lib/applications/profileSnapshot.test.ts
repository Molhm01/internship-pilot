import { describe, expect, it } from "vitest";
import {
  buildAccountPreferences,
  buildProfileSnapshot,
  missingProfileFields,
  type FactRow,
  type ProfileRow,
} from "./profileSnapshot";

function row(overrides: Partial<ProfileRow> = {}): ProfileRow {
  const empty: ProfileRow = {
    fullName: null,
    legalFirstName: null,
    legalMiddleName: null,
    legalLastName: null,
    preferredName: null,
    pronouns: null,
    email: null,
    alternateEmail: null,
    phone: null,
    phoneCountryCode: null,
    linkedin: null,
    github: null,
    website: null,
    portfolio: null,
    school: null,
    addressStreet: null,
    addressCity: null,
    addressState: null,
    addressZip: null,
    countryOfResidence: null,
    willingToRelocate: null,
    locationPreferences: null,
    internshipTermAvailability: null,
    salaryAnswerPreference: null,
    workAuthorization: null,
    requiresSponsorship: null,
    clearanceEligible: null,
    eeoGender: null,
    eeoRaceEthnicity: null,
    eeoVeteranStatus: null,
    eeoDisabilityStatus: null,
    degreeType: null,
    educationLevel: null,
    major: null,
    minor: null,
    educationStartDate: null,
    graduationDate: null,
    gpa: null,
    gpaScale: null,
    relevantCoursework: null,
    remotePreference: null,
    earliestStartDate: null,
    hasDriversLicense: null,
    meetsMinimumAge: null,
    referralSource: null,
    applicationEmail: null,
    preferredUsername: null,
    wantsAccountCreationHelp: null,
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
  return { ...empty, ...overrides };
}

const FILLED = row({
  legalFirstName: "Jordan",
  legalMiddleName: "Avery",
  legalLastName: "Ellis",
  preferredName: "Jo",
  email: "jordan@personal.example.com",
  applicationEmail: "jordan.applies@example.com",
  phone: "+1 201 555 0134",
  addressStreet: "48 Maple Avenue",
  addressCity: "Clifton",
  addressState: "New Jersey",
  addressZip: "07011",
  countryOfResidence: "United States",
  linkedin: "https://www.linkedin.com/in/jordanellis",
  github: "https://github.com/jordanellis",
  portfolio: "https://jordanellis.dev",
  school: "Rutgers University",
  degreeType: "Bachelor's Degree",
  major: "Computer Science",
  minor: "Mathematics",
  educationStartDate: "2024-09",
  graduationDate: "2027-05",
  gpa: "3.7",
  gpaScale: "4",
  relevantCoursework: JSON.stringify(["Data Structures", "Operating Systems"]),
  workAuthorization: "U.S. Citizen",
  requiresSponsorship: false,
  willingToRelocate: true,
  remotePreference: "hybrid",
  earliestStartDate: "2027-06-01",
  hasDriversLicense: true,
  meetsMinimumAge: true,
  referralSource: "LinkedIn",
  internshipTermAvailability: "Summer 2027",
});

describe("the profile snapshot", () => {
  it("maps every canonical field the user filled in", () => {
    const snapshot = buildProfileSnapshot(FILLED);

    expect(snapshot.personal).toMatchObject({
      legalFirstName: "Jordan",
      legalMiddleName: "Avery",
      legalLastName: "Ellis",
      preferredName: "Jo",
      phone: "+1 201 555 0134",
      linkedin: "https://www.linkedin.com/in/jordanellis",
      github: "https://github.com/jordanellis",
      portfolio: "https://jordanellis.dev",
    });
    expect(snapshot.personal.address).toEqual({
      line1: "48 Maple Avenue",
      city: "Clifton",
      state: "New Jersey",
      postalCode: "07011",
      country: "United States",
    });
    expect(snapshot.education[0]).toMatchObject({
      institution: "Rutgers University",
      degree: "Bachelor's Degree",
      major: "Computer Science",
      minor: "Mathematics",
      startDate: "2024-09",
      graduationDate: "2027-05",
      gpa: 3.7,
      gpaScale: 4,
      coursework: ["Data Structures", "Operating Systems"],
    });
    expect(snapshot.eligibility).toMatchObject({
      workAuthorization: "U.S. Citizen",
      requiresFutureSponsorship: false,
      willingToRelocate: true,
      hasDriversLicense: true,
      meetsMinimumAge: true,
      earliestStartDate: "2027-06-01",
      internshipAvailability: "Summer 2027",
    });
    expect(snapshot.preferences).toMatchObject({
      discoverySource: "LinkedIn",
      remotePreference: "hybrid",
    });
  });

  it("prefers the application email over the everyday one", () => {
    expect(buildProfileSnapshot(FILLED).personal.email).toBe("jordan.applies@example.com");
    expect(buildProfileSnapshot(row({ email: "only@example.com" })).personal.email).toBe(
      "only@example.com",
    );
  });

  it("omits every field the user has not filled in rather than defaulting it", () => {
    const snapshot = buildProfileSnapshot(row());
    expect(snapshot.personal.legalFirstName).toBeUndefined();
    expect(snapshot.personal.email).toBeUndefined();
    expect(snapshot.personal.address).toEqual({});
    expect(snapshot.education).toEqual([]);
    expect(snapshot.eligibility).toEqual({});
    expect(snapshot.sensitivePolicies).toEqual([]);
  });

  it("never splits a display name into a legal first and last name", () => {
    const snapshot = buildProfileSnapshot(row({ fullName: "Jordan Avery Ellis" }));
    expect(snapshot.personal.legalFirstName).toBeUndefined();
    expect(snapshot.personal.legalLastName).toBeUndefined();
  });

  it("rejects a malformed date rather than passing a half-guessed one on", () => {
    const snapshot = buildProfileSnapshot(
      row({ school: "Rutgers", graduationDate: "next spring", earliestStartDate: "soon" }),
    );
    expect(snapshot.education[0]?.graduationDate).toBeUndefined();
    expect(snapshot.eligibility.earliestStartDate).toBeUndefined();
  });

  it("includes only approved resume facts", () => {
    const facts: FactRow[] = [
      { id: "f1", type: "project", content: "Rover telemetry", detail: "Built in C++", status: "approved" },
      { id: "f2", type: "project", content: "Unapproved idea", detail: null, status: "pending" },
      { id: "f3", type: "skill", content: "Python", detail: null, status: "edited" },
      { id: "f4", type: "skill", content: "Rejected skill", detail: null, status: "rejected" },
    ];
    const snapshot = buildProfileSnapshot(row(), facts);
    expect(snapshot.projects.map((project) => project.name)).toEqual(["Rover telemetry"]);
    expect(snapshot.skills.technical).toEqual(["Python"]);
  });
});

describe("sensitive preferences", () => {
  it("turns an explicit decline into a decline policy", () => {
    const snapshot = buildProfileSnapshot(
      row({ eeoGender: "Decline to self-identify", eeoVeteranStatus: "Prefer not to answer" }),
    );
    expect(snapshot.sensitivePolicies).toEqual(
      expect.arrayContaining([
        { category: "gender", policy: "decline_to_answer" },
        { category: "veteran_status", policy: "decline_to_answer" },
      ]),
    );
  });

  it("turns an explicit substantive answer into an auto-fill policy", () => {
    const snapshot = buildProfileSnapshot(row({ eeoRaceEthnicity: "Asian" }));
    expect(snapshot.sensitivePolicies).toContainEqual({
      category: "race",
      policy: "approved_auto_fill",
      value: "Asian",
    });
  });

  it("emits nothing at all for a category the user never answered", () => {
    const snapshot = buildProfileSnapshot(row({ eeoGender: "Male" }));
    expect(snapshot.sensitivePolicies.map((policy) => policy.category)).toEqual(["gender"]);
  });

  it("treats an explicit clearance No as an answer, not as unknown", () => {
    expect(buildProfileSnapshot(row({ clearanceEligible: false })).sensitivePolicies).toContainEqual({
      category: "security_clearance",
      policy: "approved_auto_fill",
      value: "No",
    });
  });
});

describe("account preferences", () => {
  it("carries the application email and username but never a password", () => {
    const preferences = buildAccountPreferences(
      row({
        applicationEmail: "jordan.applies@example.com",
        preferredUsername: "jordanellis",
        wantsAccountCreationHelp: true,
      }),
    );
    expect(preferences).toEqual({
      applicationEmail: "jordan.applies@example.com",
      preferredUsername: "jordanellis",
      wantsAccountCreationHelp: true,
    });
    expect(JSON.stringify(preferences)).not.toMatch(/password|secret|credential/i);
  });

  it("defaults account-creation help to off", () => {
    expect(buildAccountPreferences(row()).wantsAccountCreationHelp).toBe(false);
  });
});

describe("profile completeness", () => {
  it("reports nothing missing for a filled profile", () => {
    expect(missingProfileFields(FILLED)).toEqual([]);
  });

  it("names each field an application form would ask for", () => {
    const missing = missingProfileFields(row());
    expect(missing).toContain("Legal first name");
    expect(missing).toContain("Work authorization");
    expect(missing).toContain("Graduation month/year");
    expect(missing).toContain("Sponsorship requirement");
  });

  it("counts an explicit sponsorship No as answered", () => {
    expect(missingProfileFields(row({ requiresSponsorship: false }))).not.toContain(
      "Sponsorship requirement",
    );
  });
});

describe("the snapshot never carries a credential", () => {
  it("has no password-shaped key or value anywhere", () => {
    const serialized = JSON.stringify(buildProfileSnapshot(FILLED));
    expect(serialized).not.toMatch(/password|passwd|secret|token|credential/i);
  });
});
