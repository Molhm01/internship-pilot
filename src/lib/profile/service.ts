import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth/session";

/**
 * Who owns the profile rows this request may touch.
 *
 * The session user's id, or `undefined` when there is no session — which every
 * caller turns into a 401.
 *
 * This used to have a third answer. In "local single-user mode" it returned
 * `null`, meaning *the legacy owner*: the rows written before accounts existed,
 * which carry a null `userId`. That was correct on one person's laptop and is a
 * cross-account read hosted, because the mode defaulted to ON — an unset
 * environment variable served one person's résumé, address and demographic
 * answers to whoever asked. The mode is gone, and with it the only path by
 * which this function could answer with an owner nobody signed in as.
 */
export async function resolveProfileOwner(): Promise<string | undefined> {
  const user = await currentUser();
  return user ? user.id : undefined;
}

/**
 * Reading and writing the canonical profile.
 *
 * Every write is scoped to a user id the caller already authenticated; nothing
 * here trusts an id from a request body. Every field is optional, and a value
 * the user has not entered is stored as null rather than as an empty string, so
 * "unanswered" and "answered with nothing" stay distinguishable — the agent
 * treats the first as unanswerable and must never invent a substitute.
 */

export type FullProfile = Awaited<ReturnType<typeof loadFullProfile>>;

export async function loadFullProfile(userId: string) {
  const [user, profile, educations, experiences, projects, preferences, sensitive, answers] =
    await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, displayName: true },
      }),
      prisma.userProfile.findUnique({ where: { userId } }),
      prisma.education.findMany({ where: { userId }, orderBy: { sortOrder: "asc" } }),
      prisma.experience.findMany({ where: { userId }, orderBy: { sortOrder: "asc" } }),
      prisma.project.findMany({ where: { userId }, orderBy: { sortOrder: "asc" } }),
      prisma.applicationPreferences.findUnique({ where: { userId } }),
      prisma.sensitiveAnswerPreferences.findUnique({ where: { userId } }),
      prisma.approvedAnswer.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } }),
    ]);

  return { user, profile, educations, experiences, projects, preferences, sensitive, answers };
}

/** Trimmed, or null. An empty box means "not answered", not "answered blank". */
export function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** A tri-state answer: true, false, or "the user has not said". */
export function tristate(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "yes") return true;
  if (value === "no") return false;
  return null;
}

/** JSON array of non-empty strings, or null. */
export function stringList(value: unknown): string | null {
  const entries = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? value.split(/[\n,]/)
      : [];
  const cleaned = entries.map((entry) => entry.trim()).filter(Boolean);
  return cleaned.length ? JSON.stringify(cleaned) : null;
}

export function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export async function savePersonal(userId: string, body: Record<string, unknown>) {
  const data = {
    legalFirstName: text(body.legalFirstName),
    middleName: text(body.middleName),
    legalLastName: text(body.legalLastName),
    preferredName: text(body.preferredName),
    applicationEmail: text(body.applicationEmail),
    alternateEmail: text(body.alternateEmail),
    phone: text(body.phone),
    phoneCountryCode: text(body.phoneCountryCode),
    addressLine1: text(body.addressLine1),
    addressLine2: text(body.addressLine2),
    city: text(body.city),
    state: text(body.state),
    postalCode: text(body.postalCode),
    country: text(body.country),
    linkedinUrl: text(body.linkedinUrl),
    githubUrl: text(body.githubUrl),
    portfolioUrl: text(body.portfolioUrl),
  };
  return prisma.userProfile.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
}

export async function saveApplicationPreferences(userId: string, body: Record<string, unknown>) {
  const data = {
    legallyAuthorizedToWork: tristate(body.legallyAuthorizedToWork),
    requiresSponsorshipNow: tristate(body.requiresSponsorshipNow),
    mayRequireSponsorshipLater: tristate(body.mayRequireSponsorshipLater),
    willingToRelocate: tristate(body.willingToRelocate),
    remotePreference: text(body.remotePreference),
    earliestStartDate: text(body.earliestStartDate),
    salaryPreference: text(body.salaryPreference),
    hasDriversLicense: tristate(body.hasDriversLicense),
    securityClearanceStatus: text(body.securityClearanceStatus),
    usualJobSource: text(body.usualJobSource),
  };
  return prisma.applicationPreferences.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
}

/**
 * Sensitive answers are stored only when the user explicitly chose one.
 *
 * An empty box stays null, which the agent reads as "no preference" and
 * therefore leaves the question for the user rather than answering it. That is
 * the whole mechanism behind "demographics are never inferred".
 */
export async function saveSensitivePreferences(userId: string, body: Record<string, unknown>) {
  const data = {
    gender: text(body.gender),
    raceEthnicity: text(body.raceEthnicity),
    veteranStatus: text(body.veteranStatus),
    disabilityStatus: text(body.disabilityStatus),
    pronouns: text(body.pronouns),
    declineDemographics: body.declineDemographics !== false,
  };
  return prisma.sensitiveAnswerPreferences.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
}

export function educationData(body: Record<string, unknown>) {
  return {
    school: text(body.school) ?? "",
    degree: text(body.degree),
    major: text(body.major),
    minor: text(body.minor),
    startMonth: text(body.startMonth),
    startYear: text(body.startYear),
    graduationMonth: text(body.graduationMonth),
    graduationYear: text(body.graduationYear),
    gpa: text(body.gpa),
    educationLevel: text(body.educationLevel),
    relevantCoursework: stringList(body.relevantCoursework),
    sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
  };
}

export function experienceData(body: Record<string, unknown>) {
  return {
    employer: text(body.employer) ?? "",
    title: text(body.title),
    location: text(body.location),
    startDate: text(body.startDate),
    endDate: text(body.endDate),
    currentlyEmployed: body.currentlyEmployed === true,
    responsibilities: stringList(body.responsibilities),
    approvedBullets: stringList(body.approvedBullets),
    sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
  };
}

export function projectData(body: Record<string, unknown>) {
  return {
    name: text(body.name) ?? "",
    startDate: text(body.startDate),
    endDate: text(body.endDate),
    technologies: stringList(body.technologies),
    description: text(body.description),
    approvedSkills: stringList(body.approvedSkills),
    sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
  };
}

/**
 * What is still missing before an application can be filled from this profile.
 *
 * Used to block "Apply with Application Agent" with a specific reason rather
 * than letting the user reach an employer form and discover the blanks there.
 */
export function profileGaps(profile: FullProfile): string[] {
  const personal = profile.profile;
  const preferences = profile.preferences;
  const checks: Array<[string, boolean]> = [
    ["Legal first name", Boolean(personal?.legalFirstName)],
    ["Legal last name", Boolean(personal?.legalLastName)],
    ["Application email", Boolean(personal?.applicationEmail)],
    ["Phone number", Boolean(personal?.phone)],
    ["City", Boolean(personal?.city)],
    ["State", Boolean(personal?.state)],
    ["Country", Boolean(personal?.country)],
    ["At least one education entry", profile.educations.length > 0],
    ["Work authorization", preferences?.legallyAuthorizedToWork !== null && preferences?.legallyAuthorizedToWork !== undefined],
  ];
  return checks.filter(([, ok]) => !ok).map(([label]) => label);
}

export function isProfileUsable(profile: FullProfile): boolean {
  return Boolean(profile.user) && profileGaps(profile).length === 0;
}
