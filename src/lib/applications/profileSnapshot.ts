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

/**
 * The bundle contract version.
 *
 * Bumped whenever a field the extension reads is added, removed, or given a new
 * meaning. The extension validates it and refuses a bundle it cannot read,
 * rather than silently treating a missing field as an unanswered question —
 * which would look identical to a blank profile and produce a half-filled form.
 */
export const PROFILE_SNAPSHOT_VERSION = 3;

/**
 * The bundle contract version, which is not the same number as the profile's.
 *
 * They were the same variable, and the route sent the profile version as the
 * bundle version — so bumping the profile contract silently made every bundle
 * look like it came from a newer website than the extension could read, and the
 * extension refused it. Two facts, two constants; they happen to agree today.
 */
export const BUNDLE_CONTRACT_VERSION = 3;

export type SnapshotAddress = {
  line1?: string;
  /** A real second line. Never a copy of line 1; an empty line 2 stays absent. */
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  /** The nearest metropolitan area, when it differs from the city. */
  metroRegion?: string;
};

export type SnapshotPersonal = {
  legalFirstName?: string;
  legalMiddleName?: string;
  /** True only when the user said they have no middle name. */
  noMiddleName?: boolean;
  legalLastName?: string;
  suffix?: string;
  preferredName?: string;
  pronouns?: string;
  email?: string;
  alternateEmail?: string;
  phone?: string;
  phoneCountryCode?: string;
  /** mobile | home | work | other. Absent means the user has not said. */
  phoneType?: "mobile" | "home" | "work" | "other";
  address: SnapshotAddress;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  personalWebsite?: string;
  /**
   * Which of the links above answers a form offering exactly one "Website" box.
   * Set by the user; nothing here picks one by precedence.
   */
  preferredWebsiteField?: "linkedin" | "github" | "portfolio" | "website";
};

export type SnapshotEducation = {
  id: string;
  institution: string;
  degree?: string;
  /** The level — "Bachelor's" — as distinct from the degree's full name. */
  degreeLevel?: string;
  major?: string;
  minor?: string;
  startDate?: string;
  graduationDate?: string;
  gpa?: number;
  gpaScale?: number;
  /**
   * Whether the credential has been awarded. Absent means the user has not
   * said, which stays different from "not completed": only an entry that
   * positively states completion may answer "highest degree awarded".
   */
  status?: "completed" | "in_progress";
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
  /**
   * Dates and a link. Present in the `Project` table and in the canonical
   * contract, and previously dropped here — so a form asking when a project ran
   * had nothing to fill it with even though the answer was stored.
   */
  startDate?: string;
  endDate?: string;
  url?: string;
};

export type ProfileSnapshot = {
  version: number;
  id: string;
  personal: SnapshotPersonal;
  education: SnapshotEducation[];
  /**
   * The highest credential actually awarded, and the one being studied for.
   *
   * Two fields because "Highest Level of Education" and "what are you
   * studying" are two questions with two different answers for anyone
   * mid-degree. The extension was answering the first with the second, which
   * overstates the applicant's qualifications — so both travel, and the
   * extension never derives one from the other.
   */
  highestCompletedDegree?: string;
  currentDegreeInProgress?: string;
  experience: SnapshotExperience[];
  projects: SnapshotProject[];
  /**
   * Clubs and societies, and what the applicant did outside a job or a course.
   * Both were dropped entirely: the résumé facts existed, and nothing carried
   * them, so "Activities" was unanswerable on every form that asked.
   */
  organizations: string[];
  activities: string[];
  skills: { technical: string[]; programmingLanguages: string[] };
  eligibility: {
    workAuthorization?: string;
    /** "Do you need sponsorship now?" — a different question from the next one. */
    requiresSponsorshipNow?: boolean;
    requiresFutureSponsorship?: boolean;
    willingToRelocate?: boolean;
    hasDriversLicense?: boolean;
    meetsMinimumAge?: boolean;
    earliestStartDate?: string;
    internshipAvailability?: string;
    securityClearanceStatus?: string;
  };
  preferences: {
    targetRoles: string[];
    industries: string[];
    preferredLocations: string[];
    discoverySource?: string;
    remotePreference?: "remote" | "hybrid" | "onsite" | "no_preference";
    salaryPreference?: string;
    salaryStrategy?: "negotiable" | "specific" | "decline";
    salaryMinimum?: string;
    /** Opt-in only. Absent means the user has not consented. */
    marketingTextConsent?: boolean;
    /**
     * The standing portal preference. It already travelled inside
     * `accountPreferences`, which only exists when a bundle does — so a run the
     * user started themselves had no answer at all.
     */
    employerPortalStrategy?: "prefer_guest" | "create_when_required" | "always_ask";
    resumeSelectionRules: never[];
  };
  sensitivePolicies: Array<{ category: string; policy: string; value?: string }>;
  updatedAt: string;
};

/**
 * How the applicant wants employer portals handled. Never includes a password:
 * the website never sees one, and the extension's vault is the only place a
 * credential exists.
 */
export type AccountPreferences = {
  applicationEmail?: string;
  preferredUsername?: string;
  wantsAccountCreationHelp: boolean;
  /**
   * prefer_guest | create_when_required | always_ask. Absent means the user has
   * not chosen and the extension asks rather than assuming a route.
   */
  portalStrategy?: "prefer_guest" | "create_when_required" | "always_ask";
};

/**
 * What the applicant has told us about one employer.
 *
 * Every field is optional and absence is meaningful: it means "unknown", and an
 * unknown that a form requires becomes a question for the user. None of these
 * may ever be answered from a profile-wide default, because "have you worked
 * here before" has no default that is not a fabrication.
 */
export type CompanyRelationship = {
  companyKey: string;
  companyName: string;
  previouslyEmployed?: boolean;
  previouslyInterviewed?: boolean;
  previouslyApplied?: boolean;
  familyMemberEmployed?: boolean;
  hasReferral?: boolean;
  referralName?: string;
  referralEmail?: string;
  referralRelationship?: string;
  overrides?: Record<string, string>;
};

/** Shape read from the database. Kept structural so tests need no Prisma. */
export type ProfileRow = {
  fullName: string | null;
  legalFirstName: string | null;
  legalMiddleName: string | null;
  noMiddleName: boolean | null;
  legalLastName: string | null;
  suffix: string | null;
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
  preferredWebsiteField: string | null;
  school: string | null;
  addressStreet: string | null;
  addressLine2: string | null;
  metroRegion: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressZip: string | null;
  countryOfResidence: string | null;
  willingToRelocate: boolean | null;
  locationPreferences: string | null;
  internshipTermAvailability: string | null;
  salaryAnswerPreference: string | null;
  salaryStrategy: string | null;
  salaryMinimum: string | null;
  marketingTextConsent: boolean | null;
  workAuthorization: string | null;
  /** The raw tri-state answer `workAuthorization` above is derived from. */
  legallyAuthorizedToWork: boolean | null;
  requiresSponsorship: boolean | null;
  clearanceEligible: boolean | null;
  securityClearanceStatus: string | null;
  eeoGender: string | null;
  eeoRaceEthnicity: string | null;
  eeoVeteranStatus: string | null;
  eeoDisabilityStatus: string | null;
  degreeType: string | null;
  highestDegreeAwarded: string | null;
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
  employerPortalStrategy: string | null;
  updatedAt: Date | string;
};

export type FactRow = { id: string; type: string; content: string; detail: string | null; status: string };

/** A structured work-history row, as the user entered it on the Profile page. */
export type ExperienceRow = {
  id: string;
  employer: string;
  title: string | null;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  currentlyEmployed: boolean;
  responsibilities: string | null;
  approvedBullets: string | null;
};

export type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  technologies: string | null;
  approvedSkills: string | null;
  startDate: string | null;
  endDate: string | null;
};

export type EducationRow = {
  id: string;
  school: string;
  degree: string | null;
  educationLevel: string | null;
  major: string | null;
  minor: string | null;
  startMonth: string | null;
  startYear: string | null;
  graduationMonth: string | null;
  graduationYear: string | null;
  gpa: string | null;
  relevantCoursework: string | null;
};

export type CompanyRelationshipRow = {
  companyKey: string;
  companyName: string;
  previouslyEmployed: boolean | null;
  previouslyInterviewed: boolean | null;
  previouslyApplied: boolean | null;
  familyMemberEmployed: boolean | null;
  hasReferral: boolean | null;
  referralName: string | null;
  referralEmail: string | null;
  referralRelationship: string | null;
  overrides: string | null;
};

/** Everything the snapshot builder may read. Structural, so tests need no Prisma. */
export type ProfileSources = {
  facts?: readonly FactRow[];
  experiences?: readonly ExperienceRow[];
  projects?: readonly ProjectRow[];
  educations?: readonly EducationRow[];
};

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

/** `YYYY-MM` from a separate month and year, or undefined. Never half-guessed. */
function monthYear(month: string | null, year: string | null): string | undefined {
  const cleanYear = year?.trim();
  if (!cleanYear || !/^\d{4}$/.test(cleanYear)) return undefined;
  const cleanMonth = month?.trim();
  if (!cleanMonth) return cleanYear;
  const padded = cleanMonth.padStart(2, "0");
  const value = Number(padded);
  return /^\d{2}$/.test(padded) && value >= 1 && value <= 12 ? `${cleanYear}-${padded}` : cleanYear;
}

const WEBSITE_FIELDS = ["linkedin", "github", "portfolio", "website"] as const;

function preferredWebsiteField(
  value: string | null,
): SnapshotPersonal["preferredWebsiteField"] {
  const trimmed = value?.trim();
  return WEBSITE_FIELDS.find((entry) => entry === trimmed);
}

const SALARY_STRATEGIES = ["negotiable", "specific", "decline"] as const;

function salaryStrategy(value: string | null): ProfileSnapshot["preferences"]["salaryStrategy"] {
  const trimmed = value?.trim();
  return SALARY_STRATEGIES.find((entry) => entry === trimmed);
}

const PORTAL_STRATEGIES = ["prefer_guest", "create_when_required", "always_ask"] as const;

function portalStrategy(value: string | null): AccountPreferences["portalStrategy"] {
  const trimmed = value?.trim();
  return PORTAL_STRATEGIES.find((entry) => entry === trimmed);
}

/**
 * Builds the snapshot.
 *
 * Structured `experiences`/`projects`/`educations` rows are preferred wherever
 * they exist, because an application form asks for an employer, a title and two
 * dates as separate answers and a résumé fact is one line of prose that cannot
 * be split into them without guessing. Résumé facts remain the fallback so a
 * profile that has only ever been populated from a résumé still works.
 */
export function buildProfileSnapshot(
  row: ProfileRow,
  sources: readonly FactRow[] | ProfileSources = [],
): ProfileSnapshot {
  const { facts = [], experiences = [], projects: projectRows = [], educations = [] } =
    Array.isArray(sources) ? { facts: sources as readonly FactRow[] } : (sources as ProfileSources);

  const institution = text(row.school);
  const primaryEducation: SnapshotEducation[] = institution
    ? [
        {
          id: "education-primary",
          institution,
          ...(text(row.degreeType) ? { degree: text(row.degreeType) } : {}),
          ...(text(row.educationLevel) ? { degreeLevel: text(row.educationLevel) } : {}),
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

  // Résumé-derived education, used only for schools the structured rows and the
  // profile's own `school` column do not already name. Without this, a profile
  // populated entirely from a résumé — which is how this one was populated —
  // reached the extension with one education entry instead of three.
  const namedInstitutions = new Set(
    [institution, ...educations.map((entry) => entry.school)]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase().replace(/\s+/g, " ").trim()),
  );
  const factEducation: SnapshotEducation[] = approvedFacts(facts, "education")
    .filter(
      (fact) =>
        !namedInstitutions.has(fact.content.toLowerCase().replace(/\s+/g, " ").trim()),
    )
    .map((fact) => ({
      id: fact.id,
      institution: fact.content,
      // The detail line is prose. It is carried as the degree only when the
      // user's own structured columns say nothing, and it is never split into
      // a major and a graduation date by guessing at its punctuation.
      ...(text(fact.detail) ? { degree: text(fact.detail) } : {}),
      coursework: [],
      honors: [],
      activities: [],
    }));

  const education: SnapshotEducation[] = [
    ...primaryEducation,
    ...factEducation,
    ...educations.map((entry) => ({
      id: entry.id,
      institution: entry.school,
      ...(text(entry.degree) ? { degree: text(entry.degree) } : {}),
      ...(text(entry.educationLevel) ? { degreeLevel: text(entry.educationLevel) } : {}),
      ...(text(entry.major) ? { major: text(entry.major) } : {}),
      ...(text(entry.minor) ? { minor: text(entry.minor) } : {}),
      ...(monthYear(entry.startMonth, entry.startYear)
        ? { startDate: monthYear(entry.startMonth, entry.startYear) }
        : {}),
      ...(monthYear(entry.graduationMonth, entry.graduationYear)
        ? { graduationDate: monthYear(entry.graduationMonth, entry.graduationYear) }
        : {}),
      ...(numeric(entry.gpa) !== undefined ? { gpa: numeric(entry.gpa) } : {}),
      coursework: jsonArray(entry.relevantCoursework),
      honors: [],
      activities: [],
    })),
  ];

  const experience: SnapshotExperience[] = experiences.length
    ? experiences.map((entry) => ({
        id: entry.id,
        employer: entry.employer,
        ...(text(entry.title) ? { title: text(entry.title) } : {}),
        ...(text(entry.location) ? { location: text(entry.location) } : {}),
        ...(text(entry.startDate) ? { startDate: text(entry.startDate) } : {}),
        ...(text(entry.endDate) ? { endDate: text(entry.endDate) } : {}),
        current: entry.currentlyEmployed,
        responsibilities: jsonArray(entry.responsibilities),
        achievements: jsonArray(entry.approvedBullets),
      }))
    : approvedFacts(facts, "experience").map((fact) => ({
        id: fact.id,
        employer: fact.content,
        current: false,
        responsibilities: fact.detail ? [fact.detail] : [],
        achievements: [],
      }));

  const projects: SnapshotProject[] = projectRows.length
    ? projectRows.map((entry) => ({
        id: entry.id,
        name: entry.name,
        ...(text(entry.description) ? { description: text(entry.description) } : {}),
        technologies: jsonArray(entry.technologies),
        accomplishments: jsonArray(entry.approvedSkills),
        ...(partialDate(entry.startDate) ? { startDate: partialDate(entry.startDate) } : {}),
        ...(partialDate(entry.endDate) ? { endDate: partialDate(entry.endDate) } : {}),
      }))
    : approvedFacts(facts, "project").map((fact) => ({
        id: fact.id,
        name: fact.content,
        ...(fact.detail ? { description: fact.detail } : {}),
        technologies: [],
        accomplishments: [],
      }));

  // Skills the user approved on the résumé, plus every technology and skill a
  // project entry evidences. Deduplicated, order preserved.
  const skills = [
    ...new Set([
      ...approvedFacts(facts, "skill").map((fact) => fact.content),
      ...projectRows.flatMap((entry) => [
        ...jsonArray(entry.technologies),
        ...jsonArray(entry.approvedSkills),
      ]),
    ]),
  ];

  // Clubs, societies, and the things the applicant did outside a job or a
  // course. Approved résumé facts are the only source; nothing here classifies
  // an activity as an organization or vice versa by reading its wording.
  const activities = approvedFacts(facts, "activity").map((fact) => fact.content);
  const organizations = approvedFacts(facts, "organization").map((fact) => fact.content);

  const sensitivePolicies = [
    sensitivePolicy("gender", row.eeoGender),
    sensitivePolicy("race", row.eeoRaceEthnicity),
    sensitivePolicy("veteran_status", row.eeoVeteranStatus),
    sensitivePolicy("disability", row.eeoDisabilityStatus),
    // Sponsorship is a protected question, so it becomes a policy only from an
    // explicit boolean. The extension still shows it for confirmation before
    // disclosing it; what this removes is the guessing, not the review.
    typeof row.requiresSponsorship === 'boolean'
      ? {
          category: 'sponsorship',
          policy: 'approved_auto_fill',
          value: row.requiresSponsorship ? 'Yes' : 'No',
        }
      : null,
    // Clearance is a yes/no the user set deliberately; false is as explicit as true.
    // The status in words wins when the user wrote one, because a form usually
    // wants "Not eligible" rather than "No".
    text(row.securityClearanceStatus)
      ? {
          category: "security_clearance",
          policy: "approved_auto_fill",
          value: text(row.securityClearanceStatus)!,
        }
      : typeof row.clearanceEligible === "boolean"
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
    version: PROFILE_SNAPSHOT_VERSION,
    id: "primary",
    personal: {
      ...(text(row.legalFirstName) ? { legalFirstName: text(row.legalFirstName) } : {}),
      ...(text(row.legalMiddleName) ? { legalMiddleName: text(row.legalMiddleName) } : {}),
      // Emitted only when true. A false here would be indistinguishable from
      // "the user has not said", and a form asking to confirm no middle name
      // would then be answered from silence.
      ...(row.noMiddleName === true ? { noMiddleName: true } : {}),
      ...(text(row.legalLastName) ? { legalLastName: text(row.legalLastName) } : {}),
      ...(text(row.suffix) ? { suffix: text(row.suffix) } : {}),
      ...(text(row.preferredName) ? { preferredName: text(row.preferredName) } : {}),
      ...(text(row.pronouns) ? { pronouns: text(row.pronouns) } : {}),
      // The application email wins when set: it is the address the user chose
      // for employers, which is often not their everyday one.
      ...(text(row.applicationEmail) ?? text(row.email)
        ? { email: text(row.applicationEmail) ?? text(row.email) }
        : {}),
      ...(text(row.alternateEmail) ? { alternateEmail: text(row.alternateEmail) } : {}),
      ...(text(row.phone) ? { phone: text(row.phone) } : {}),
      ...(text(row.phoneCountryCode) ? { phoneCountryCode: text(row.phoneCountryCode) } : {}),
      address: {
        ...(text(row.addressStreet) ? { line1: text(row.addressStreet) } : {}),
        // Only a genuine second line. When the user left it empty the key is
        // absent, which is what stops the executor copying line 1 into it.
        ...(text(row.addressLine2) ? { line2: text(row.addressLine2) } : {}),
        ...(text(row.addressCity) ? { city: text(row.addressCity) } : {}),
        ...(text(row.addressState) ? { state: text(row.addressState) } : {}),
        ...(text(row.addressZip) ? { postalCode: text(row.addressZip) } : {}),
        ...(text(row.countryOfResidence) ? { country: text(row.countryOfResidence) } : {}),
        ...(text(row.metroRegion) ? { metroRegion: text(row.metroRegion) } : {}),
      },
      ...(text(row.linkedin) ? { linkedin: text(row.linkedin) } : {}),
      ...(text(row.github) ? { github: text(row.github) } : {}),
      ...(text(row.portfolio) ? { portfolio: text(row.portfolio) } : {}),
      ...(text(row.website) ? { personalWebsite: text(row.website) } : {}),
      ...(preferredWebsiteField(row.preferredWebsiteField)
        ? { preferredWebsiteField: preferredWebsiteField(row.preferredWebsiteField) }
        : {}),
    },
    education,
    ...(text(row.highestDegreeAwarded)
      ? { highestCompletedDegree: text(row.highestDegreeAwarded) }
      : {}),
    ...(text(row.degreeType) ? { currentDegreeInProgress: text(row.degreeType) } : {}),
    experience,
    projects,
    organizations,
    activities,
    skills: { technical: skills, programmingLanguages: [] },
    eligibility: {
      ...(text(row.workAuthorization) ? { workAuthorization: text(row.workAuthorization) } : {}),
      ...(bool(row.requiresSponsorship) !== undefined
        ? {
            requiresSponsorshipNow: bool(row.requiresSponsorship),
            requiresFutureSponsorship: bool(row.requiresSponsorship),
          }
        : {}),
      ...(text(row.securityClearanceStatus)
        ? { securityClearanceStatus: text(row.securityClearanceStatus) }
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
      ...(salaryStrategy(row.salaryStrategy) ? { salaryStrategy: salaryStrategy(row.salaryStrategy) } : {}),
      ...(text(row.salaryMinimum) ? { salaryMinimum: text(row.salaryMinimum) } : {}),
      // Emitted only when the user opted in. Absence is not consent, and a
      // `false` would read as an explicit refusal the user never gave.
      ...(row.marketingTextConsent === true ? { marketingTextConsent: true } : {}),
      ...(portalStrategy(row.employerPortalStrategy)
        ? { employerPortalStrategy: portalStrategy(row.employerPortalStrategy) }
        : {}),
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
    ...(portalStrategy(row.employerPortalStrategy)
      ? { portalStrategy: portalStrategy(row.employerPortalStrategy) }
      : {}),
  };
}

/** Normalizes a company name to the key relationship facts are stored under. */
export function companyKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The relationship facts for one company, in bundle shape.
 *
 * Returns null when there is no row: "we know nothing about this employer" must
 * stay distinguishable from "we know the answer is no".
 */
export function buildCompanyRelationship(
  row: CompanyRelationshipRow | null | undefined,
): CompanyRelationship | null {
  if (!row) return null;
  let overrides: Record<string, string> | undefined;
  if (row.overrides) {
    try {
      const parsed: unknown = JSON.parse(row.overrides);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        overrides = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
      }
    } catch {
      // A corrupt override blob loses the overrides, not the whole relationship.
      overrides = undefined;
    }
  }
  return {
    companyKey: row.companyKey,
    companyName: row.companyName,
    ...(bool(row.previouslyEmployed) !== undefined ? { previouslyEmployed: bool(row.previouslyEmployed) } : {}),
    ...(bool(row.previouslyInterviewed) !== undefined
      ? { previouslyInterviewed: bool(row.previouslyInterviewed) }
      : {}),
    ...(bool(row.previouslyApplied) !== undefined ? { previouslyApplied: bool(row.previouslyApplied) } : {}),
    ...(bool(row.familyMemberEmployed) !== undefined
      ? { familyMemberEmployed: bool(row.familyMemberEmployed) }
      : {}),
    ...(bool(row.hasReferral) !== undefined ? { hasReferral: bool(row.hasReferral) } : {}),
    ...(text(row.referralName) ? { referralName: text(row.referralName) } : {}),
    ...(text(row.referralEmail) ? { referralEmail: text(row.referralEmail) } : {}),
    ...(text(row.referralRelationship) ? { referralRelationship: text(row.referralRelationship) } : {}),
    ...(overrides && Object.keys(overrides).length ? { overrides } : {}),
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
    // Needed the moment an employer portal wants an account rather than a form.
    ["Application email for employer accounts", Boolean(text(row.applicationEmail))],
  ];
  return checks.filter(([, present]) => !present).map(([label]) => label);
}
