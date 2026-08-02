/**
 * The canonical profile snapshot Internship Pilot hands to the extension.
 *
 * Internship Pilot is the source of truth. The extension does not maintain a
 * second copy of the user's identity — it receives this snapshot inside the
 * application bundle and answers factual questions from it.
 *
 * Two rules shape every mapping below:
 *
 * 1. A value the user has not entered is omitted, never defaulted. A missing
 *    field means "unanswerable", and the agent must leave it blank rather than
 *    substituting something plausible.
 * 2. Nothing is derived by guessing. A legal first name comes from the legal
 *    first name column, not from splitting a display name on whitespace.
 *
 * No password or credential of any kind appears in this snapshot.
 */

export type SnapshotAddress = {
  line1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
};

export type SnapshotPersonal = {
  legalFirstName?: string;
  legalMiddleName?: string;
  legalLastName?: string;
  preferredName?: string;
  pronouns?: string;
  email?: string;
  alternateEmail?: string;
  phone?: string;
  address: SnapshotAddress;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  personalWebsite?: string;
};

export type SnapshotEducation = {
  id: string;
  institution: string;
  degree?: string;
  major?: string;
  minor?: string;
  startDate?: string;
  graduationDate?: string;
  gpa?: number;
  gpaScale?: number;
  coursework: string[];
  honors: string[];
  activities: string[];
};

export type SnapshotExperience = {
  id: string;
  employer: string;
  title?: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  current: boolean;
  responsibilities: string[];
  achievements: string[];
};

export type SnapshotProject = {
  id: string;
  name: string;
  description?: string;
  technologies: string[];
  accomplishments: string[];
};

export type ProfileSnapshot = {
  id: string;
  personal: SnapshotPersonal;
  education: SnapshotEducation[];
  experience: SnapshotExperience[];
  projects: SnapshotProject[];
  skills: { technical: string[]; programmingLanguages: string[] };
  eligibility: {
    workAuthorization?: string;
    requiresFutureSponsorship?: boolean;
    willingToRelocate?: boolean;
    hasDriversLicense?: boolean;
    meetsMinimumAge?: boolean;
    earliestStartDate?: string;
    internshipAvailability?: string;
  };
  preferences: {
    targetRoles: string[];
    industries: string[];
    preferredLocations: string[];
    discoverySource?: string;
    remotePreference?: "remote" | "hybrid" | "onsite" | "no_preference";
    salaryPreference?: string;
    resumeSelectionRules: never[];
  };
  sensitivePolicies: Array<{ category: string; policy: string; value?: string }>;
  updatedAt: string;
};

/** The account-creation preferences. Never includes a password. */
export type AccountPreferences = {
  applicationEmail?: string;
  preferredUsername?: string;
  wantsAccountCreationHelp: boolean;
};

/** Shape read from the database. Kept structural so tests need no Prisma. */
export type ProfileRow = {
  fullName: string | null;
  legalFirstName: string | null;
  legalMiddleName: string | null;
  legalLastName: string | null;
  preferredName: string | null;
  pronouns: string | null;
  email: string | null;
  alternateEmail: string | null;
  phone: string | null;
  phoneCountryCode: string | null;
  linkedin: string | null;
  github: string | null;
  website: string | null;
  portfolio: string | null;
  school: string | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressZip: string | null;
  countryOfResidence: string | null;
  willingToRelocate: boolean | null;
  locationPreferences: string | null;
  internshipTermAvailability: string | null;
  salaryAnswerPreference: string | null;
  workAuthorization: string | null;
  requiresSponsorship: boolean | null;
  clearanceEligible: boolean | null;
  eeoGender: string | null;
  eeoRaceEthnicity: string | null;
  eeoVeteranStatus: string | null;
  eeoDisabilityStatus: string | null;
  degreeType: string | null;
  educationLevel: string | null;
  major: string | null;
  minor: string | null;
  educationStartDate: string | null;
  graduationDate: string | null;
  gpa: string | null;
  gpaScale: string | null;
  relevantCoursework: string | null;
  remotePreference: string | null;
  earliestStartDate: string | null;
  hasDriversLicense: boolean | null;
  meetsMinimumAge: boolean | null;
  referralSource: string | null;
  applicationEmail: string | null;
  preferredUsername: string | null;
  wantsAccountCreationHelp: boolean | null;
  updatedAt: Date | string;
};

export type FactRow = { id: string; type: string; content: string; detail: string | null; status: string };

/** Trimmed, or undefined when the user has not entered anything. */
function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function bool(value: boolean | null | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function jsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    // A hand-edited comma list is still the user's data; it is not a reason to
    // drop the whole field.
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
}

/** A GPA the user typed, as a number, or undefined when it is not one. */
function numeric(value: string | null | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `YYYY-MM` or `YYYY`, or undefined. Never a partially-guessed date. */
function partialDate(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^\d{4}(-\d{2})?$/.test(trimmed) ? trimmed : undefined;
}

function isoDate(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

const REMOTE_PREFERENCES = ["remote", "hybrid", "onsite", "no_preference"] as const;

function remotePreference(value: string | null | undefined): ProfileSnapshot["preferences"]["remotePreference"] {
  const trimmed = value?.trim();
  return REMOTE_PREFERENCES.find((entry) => entry === trimmed);
}

/**
 * A sensitive answer becomes a policy only when the user actually chose one.
 *
 * "Decline to answer" is an explicit choice and becomes a decline policy. An
 * empty column is not a choice, so no policy is emitted and the agent has
 * nothing to act on — which is what makes "never inferred" true rather than
 * merely intended.
 */
function sensitivePolicy(
  category: string,
  stored: string | null,
): { category: string; policy: string; value?: string } | null {
  const value = text(stored);
  if (!value) return null;
  if (/^(decline|prefer not|choose not|do not wish|don't wish)/i.test(value)) {
    return { category, policy: "decline_to_answer" };
  }
  return { category, policy: "approved_auto_fill", value };
}

function approvedFacts(facts: readonly FactRow[], type: string): FactRow[] {
  return facts.filter((fact) => fact.type === type && (fact.status === "approved" || fact.status === "edited"));
}

/**
 * Builds the snapshot. `facts` supplies the approved experience, project and
 * skill entries that live in the resume-fact library; nothing unapproved is
 * ever included.
 */
export function buildProfileSnapshot(row: ProfileRow, facts: readonly FactRow[] = []): ProfileSnapshot {
  const institution = text(row.school);
  const education: SnapshotEducation[] = institution
    ? [
        {
          id: "education-primary",
          institution,
          ...(text(row.degreeType) ? { degree: text(row.degreeType) } : {}),
          ...(text(row.major) ? { major: text(row.major) } : {}),
          ...(text(row.minor) ? { minor: text(row.minor) } : {}),
          ...(partialDate(row.educationStartDate) ? { startDate: partialDate(row.educationStartDate) } : {}),
          ...(partialDate(row.graduationDate) ? { graduationDate: partialDate(row.graduationDate) } : {}),
          ...(numeric(row.gpa) !== undefined ? { gpa: numeric(row.gpa) } : {}),
          ...(numeric(row.gpaScale) !== undefined ? { gpaScale: numeric(row.gpaScale) } : {}),
          coursework: jsonArray(row.relevantCoursework),
          honors: [],
          activities: [],
        },
      ]
    : [];

  const experience: SnapshotExperience[] = approvedFacts(facts, "experience").map((fact) => ({
    id: fact.id,
    employer: fact.content,
    ...(fact.detail ? { title: undefined } : {}),
    current: false,
    responsibilities: fact.detail ? [fact.detail] : [],
    achievements: [],
  }));

  const projects: SnapshotProject[] = approvedFacts(facts, "project").map((fact) => ({
    id: fact.id,
    name: fact.content,
    ...(fact.detail ? { description: fact.detail } : {}),
    technologies: [],
    accomplishments: [],
  }));

  const skills = approvedFacts(facts, "skill").map((fact) => fact.content);

  const sensitivePolicies = [
    sensitivePolicy("gender", row.eeoGender),
    sensitivePolicy("race", row.eeoRaceEthnicity),
    sensitivePolicy("veteran_status", row.eeoVeteranStatus),
    sensitivePolicy("disability", row.eeoDisabilityStatus),
    // Clearance is a yes/no the user set deliberately; false is as explicit as true.
    typeof row.clearanceEligible === "boolean"
      ? {
          category: "security_clearance",
          policy: "approved_auto_fill",
          value: row.clearanceEligible ? "Yes" : "No",
        }
      : null,
    text(row.salaryAnswerPreference)
      ? {
          category: "salary_expectation",
          policy: "approved_auto_fill",
          value: text(row.salaryAnswerPreference)!,
        }
      : null,
  ].filter((entry): entry is { category: string; policy: string; value?: string } => entry !== null);

  return {
    id: "primary",
    personal: {
      ...(text(row.legalFirstName) ? { legalFirstName: text(row.legalFirstName) } : {}),
      ...(text(row.legalMiddleName) ? { legalMiddleName: text(row.legalMiddleName) } : {}),
      ...(text(row.legalLastName) ? { legalLastName: text(row.legalLastName) } : {}),
      ...(text(row.preferredName) ? { preferredName: text(row.preferredName) } : {}),
      ...(text(row.pronouns) ? { pronouns: text(row.pronouns) } : {}),
      // The application email wins when set: it is the address the user chose
      // for employers, which is often not their everyday one.
      ...(text(row.applicationEmail) ?? text(row.email)
        ? { email: text(row.applicationEmail) ?? text(row.email) }
        : {}),
      ...(text(row.alternateEmail) ? { alternateEmail: text(row.alternateEmail) } : {}),
      ...(text(row.phone) ? { phone: text(row.phone) } : {}),
      address: {
        ...(text(row.addressStreet) ? { line1: text(row.addressStreet) } : {}),
        ...(text(row.addressCity) ? { city: text(row.addressCity) } : {}),
        ...(text(row.addressState) ? { state: text(row.addressState) } : {}),
        ...(text(row.addressZip) ? { postalCode: text(row.addressZip) } : {}),
        ...(text(row.countryOfResidence) ? { country: text(row.countryOfResidence) } : {}),
      },
      ...(text(row.linkedin) ? { linkedin: text(row.linkedin) } : {}),
      ...(text(row.github) ? { github: text(row.github) } : {}),
      ...(text(row.portfolio) ? { portfolio: text(row.portfolio) } : {}),
      ...(text(row.website) ? { personalWebsite: text(row.website) } : {}),
    },
    education,
    experience,
    projects,
    skills: { technical: skills, programmingLanguages: [] },
    eligibility: {
      ...(text(row.workAuthorization) ? { workAuthorization: text(row.workAuthorization) } : {}),
      ...(bool(row.requiresSponsorship) !== undefined
        ? { requiresFutureSponsorship: bool(row.requiresSponsorship) }
        : {}),
      ...(bool(row.willingToRelocate) !== undefined ? { willingToRelocate: bool(row.willingToRelocate) } : {}),
      ...(bool(row.hasDriversLicense) !== undefined ? { hasDriversLicense: bool(row.hasDriversLicense) } : {}),
      ...(bool(row.meetsMinimumAge) !== undefined ? { meetsMinimumAge: bool(row.meetsMinimumAge) } : {}),
      ...(isoDate(row.earliestStartDate) ? { earliestStartDate: isoDate(row.earliestStartDate) } : {}),
      ...(text(row.internshipTermAvailability)
        ? { internshipAvailability: text(row.internshipTermAvailability) }
        : {}),
    },
    preferences: {
      targetRoles: [],
      industries: [],
      preferredLocations: jsonArray(row.locationPreferences),
      ...(text(row.referralSource) ? { discoverySource: text(row.referralSource) } : {}),
      ...(remotePreference(row.remotePreference) ? { remotePreference: remotePreference(row.remotePreference) } : {}),
      ...(text(row.salaryAnswerPreference) ? { salaryPreference: text(row.salaryAnswerPreference) } : {}),
      resumeSelectionRules: [],
    },
    sensitivePolicies,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : row.updatedAt.toISOString(),
  };
}

export function buildAccountPreferences(row: ProfileRow): AccountPreferences {
  return {
    ...(text(row.applicationEmail) ?? text(row.email)
      ? { applicationEmail: text(row.applicationEmail) ?? text(row.email) }
      : {}),
    ...(text(row.preferredUsername) ? { preferredUsername: text(row.preferredUsername) } : {}),
    wantsAccountCreationHelp: row.wantsAccountCreationHelp === true,
  };
}

/**
 * Every field an application form could ask for that the user has not filled
 * in. Shown on the profile page so gaps are visible before an application, not
 * discovered as blanks on an employer's form.
 */
export function missingProfileFields(row: ProfileRow): string[] {
  const checks: Array<[string, boolean]> = [
    ["Legal first name", Boolean(text(row.legalFirstName))],
    ["Legal last name", Boolean(text(row.legalLastName))],
    ["Application email", Boolean(text(row.applicationEmail) ?? text(row.email))],
    ["Phone", Boolean(text(row.phone))],
    ["Street address", Boolean(text(row.addressStreet))],
    ["City", Boolean(text(row.addressCity))],
    ["State", Boolean(text(row.addressState))],
    ["Postal code", Boolean(text(row.addressZip))],
    ["Country", Boolean(text(row.countryOfResidence))],
    ["School", Boolean(text(row.school))],
    ["Degree type", Boolean(text(row.degreeType))],
    ["Major", Boolean(text(row.major))],
    ["Graduation month/year", Boolean(partialDate(row.graduationDate))],
    ["Work authorization", Boolean(text(row.workAuthorization))],
    ["Sponsorship requirement", bool(row.requiresSponsorship) !== undefined],
    ["Earliest start date", Boolean(isoDate(row.earliestStartDate))],
  ];
  return checks.filter(([, present]) => !present).map(([label]) => label);
}
