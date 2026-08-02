import { describe, expect, it } from "vitest";
import {
  buildAccountPreferences,
  buildCompanyRelationship,
  buildProfileSnapshot,
  companyKey,
  missingProfileFields,
  PROFILE_SNAPSHOT_VERSION,
  type FactRow,
  type ProfileRow,
} from "./profileSnapshot";

function row(overrides: Partial<ProfileRow> = {}): ProfileRow {
  const empty: ProfileRow = {
    fullName: null,
    legalFirstName: null,
    legalMiddleName: null,
    noMiddleName: null,
    legalLastName: null,
    suffix: null,
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
    preferredWebsiteField: null,
    school: null,
    addressStreet: null,
    addressLine2: null,
    metroRegion: null,
    addressCity: null,
    addressState: null,
    addressZip: null,
    countryOfResidence: null,
    willingToRelocate: null,
    locationPreferences: null,
    internshipTermAvailability: null,
    salaryAnswerPreference: null,
    salaryStrategy: null,
    salaryMinimum: null,
    marketingTextConsent: null,
    workAuthorization: null,
    requiresSponsorship: null,
    clearanceEligible: null,
    securityClearanceStatus: null,
    eeoGender: null,
    eeoRaceEthnicity: null,
    eeoVeteranStatus: null,
    eeoDisabilityStatus: null,
    degreeType: null,
    highestDegreeAwarded: null,
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
    employerPortalStrategy: null,
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

describe("the fields the Taleo run got wrong", () => {
  it("never puts anything in address line 2 when the user has no second line", () => {
    const snapshot = buildProfileSnapshot(row({ addressStreet: "48 Maple Avenue" }));
    expect(snapshot.personal.address.line1).toBe("48 Maple Avenue");
    // The bug was line 1 being copied here. Absent, not equal to line 1.
    expect(snapshot.personal.address.line2).toBeUndefined();
  });

  it("carries a real address line 2 through when there is one", () => {
    const snapshot = buildProfileSnapshot(
      row({ addressStreet: "48 Maple Avenue", addressLine2: "Apt 3B" }),
    );
    expect(snapshot.personal.address.line2).toBe("Apt 3B");
  });

  it("keeps the metro region distinct from the city", () => {
    const snapshot = buildProfileSnapshot(
      row({ addressCity: "Clifton", metroRegion: "New York City Metro Area" }),
    );
    expect(snapshot.personal.address.city).toBe("Clifton");
    expect(snapshot.personal.address.metroRegion).toBe("New York City Metro Area");
  });

  it("distinguishes the degree being pursued from the highest one awarded", () => {
    const snapshot = buildProfileSnapshot(
      row({ school: "NJIT", degreeType: "Bachelor's Degree", highestDegreeAwarded: "High School Diploma" }),
    );
    expect(snapshot.education[0]?.degree).toBe("Bachelor's Degree");
    // The awarded degree is a separate answer and must not overwrite the first.
    expect(snapshot.education[0]?.degree).not.toBe("High School Diploma");
  });

  it("emits a suffix only when the user typed one", () => {
    expect(buildProfileSnapshot(row()).personal.suffix).toBeUndefined();
    expect(buildProfileSnapshot(row({ suffix: "Jr." })).personal.suffix).toBe("Jr.");
  });

  it("says 'no middle name' only when the user said so, never from a blank field", () => {
    expect(buildProfileSnapshot(row()).personal.noMiddleName).toBeUndefined();
    expect(buildProfileSnapshot(row({ noMiddleName: false })).personal.noMiddleName).toBeUndefined();
    expect(buildProfileSnapshot(row({ noMiddleName: true })).personal.noMiddleName).toBe(true);
  });

  it("does not pick a website by precedence when the user has not chosen one", () => {
    const snapshot = buildProfileSnapshot(
      row({ linkedin: "https://linkedin.example/x", github: "https://github.example/x" }),
    );
    expect(snapshot.personal.preferredWebsiteField).toBeUndefined();
    const chosen = buildProfileSnapshot(row({ preferredWebsiteField: "github" }));
    expect(chosen.personal.preferredWebsiteField).toBe("github");
  });

  it("ignores a website preference that is not one of the stored links", () => {
    expect(
      buildProfileSnapshot(row({ preferredWebsiteField: "myspace" })).personal.preferredWebsiteField,
    ).toBeUndefined();
  });

  it("carries the preferred locations the user listed and never invents one", () => {
    expect(buildProfileSnapshot(row()).preferences.preferredLocations).toEqual([]);
    expect(
      buildProfileSnapshot(row({ locationPreferences: JSON.stringify(["Newark, NJ", "Remote"]) }))
        .preferences.preferredLocations,
    ).toEqual(["Newark, NJ", "Remote"]);
  });
});

describe("consent is never assumed", () => {
  it("omits marketing-text consent unless the user opted in", () => {
    expect(buildProfileSnapshot(row()).preferences.marketingTextConsent).toBeUndefined();
    expect(
      buildProfileSnapshot(row({ marketingTextConsent: false })).preferences.marketingTextConsent,
    ).toBeUndefined();
    expect(
      buildProfileSnapshot(row({ marketingTextConsent: true })).preferences.marketingTextConsent,
    ).toBe(true);
  });
});

describe("the bundle contract is versioned", () => {
  it("stamps every snapshot with the current version", () => {
    expect(buildProfileSnapshot(row()).version).toBe(PROFILE_SNAPSHOT_VERSION);
  });
});

describe("structured entries beat résumé prose", () => {
  it("splits an employer, a title and dates into separate answers", () => {
    const snapshot = buildProfileSnapshot(row(), {
      experiences: [
        {
          id: "x1",
          employer: "Lockheed Martin",
          title: "Engineering Intern",
          location: "Moorestown, NJ",
          startDate: "2026-06",
          endDate: "2026-08",
          currentlyEmployed: false,
          responsibilities: JSON.stringify(["Wrote test fixtures"]),
          approvedBullets: JSON.stringify(["Cut regression time by half"]),
        },
      ],
    });
    expect(snapshot.experience[0]).toMatchObject({
      employer: "Lockheed Martin",
      title: "Engineering Intern",
      startDate: "2026-06",
      endDate: "2026-08",
      current: false,
      responsibilities: ["Wrote test fixtures"],
      achievements: ["Cut regression time by half"],
    });
  });

  it("falls back to approved résumé facts when no structured entry exists", () => {
    const facts: FactRow[] = [
      { id: "f1", type: "experience", content: "Campus IT", detail: "Helpdesk", status: "approved" },
    ];
    const snapshot = buildProfileSnapshot(row(), { facts });
    expect(snapshot.experience.map((entry) => entry.employer)).toEqual(["Campus IT"]);
  });

  it("still accepts a bare fact array, so the old call shape keeps working", () => {
    const facts: FactRow[] = [
      { id: "f1", type: "skill", content: "Verilog", detail: null, status: "approved" },
    ];
    expect(buildProfileSnapshot(row(), facts).skills.technical).toEqual(["Verilog"]);
  });
});

describe("company relationship facts", () => {
  const base = {
    companyKey: "acme corp",
    companyName: "Acme Corp",
    previouslyEmployed: null,
    previouslyInterviewed: null,
    previouslyApplied: null,
    familyMemberEmployed: null,
    hasReferral: null,
    referralName: null,
    referralEmail: null,
    referralRelationship: null,
    overrides: null,
  };

  it("is null when the user has said nothing about the employer", () => {
    expect(buildCompanyRelationship(null)).toBeNull();
  });

  it("omits every unanswered fact rather than reporting it as No", () => {
    const relationship = buildCompanyRelationship(base);
    expect(relationship).toEqual({ companyKey: "acme corp", companyName: "Acme Corp" });
    expect(relationship?.previouslyEmployed).toBeUndefined();
  });

  it("keeps an explicit No as an answer", () => {
    expect(buildCompanyRelationship({ ...base, previouslyEmployed: false })?.previouslyEmployed).toBe(
      false,
    );
  });

  it("carries a referral only when the user recorded one", () => {
    const relationship = buildCompanyRelationship({
      ...base,
      hasReferral: true,
      referralName: "Dana Reed",
      referralEmail: "dana@acme.example.com",
      referralRelationship: "Former manager",
    });
    expect(relationship).toMatchObject({
      hasReferral: true,
      referralName: "Dana Reed",
      referralRelationship: "Former manager",
    });
    expect(buildCompanyRelationship(base)?.referralName).toBeUndefined();
  });

  it("survives a corrupt override blob without losing the rest of the row", () => {
    const relationship = buildCompanyRelationship({ ...base, overrides: "{not json" });
    expect(relationship?.companyName).toBe("Acme Corp");
    expect(relationship?.overrides).toBeUndefined();
  });

  it("normalizes a company name to one key regardless of spacing and case", () => {
    expect(companyKey("  Acme   Corp ")).toBe("acme corp");
    expect(companyKey("ACME CORP")).toBe(companyKey("acme corp"));
  });
});
