import { prisma } from "@/lib/db";
import type { ProfileRow } from "@/lib/applications/profileSnapshot";

/**
 * The application profile, assembled from the models that actually own it.
 *
 * ## Why this exists
 *
 * `ApplicationProfile` was a singleton: one row, `id = "default"`, holding one
 * person's legal name, address, phone number, work authorization and EEO
 * answers. Hosted, every signed-in user would have read the same row — the most
 * direct disclosure in the audit.
 *
 * The data it held is not homeless, though. The same facts already have
 * user-owned homes: `UserProfile` for identity and contact,
 * `ApplicationPreferences` for work authorization and logistics,
 * `SensitiveAnswerPreferences` for demographics, and `Education` for the
 * degree. So the singleton is retired as a *table read*, and this function
 * assembles the same shape from those four.
 *
 * ## Why a projection rather than a rewrite
 *
 * `ProfileRow` is consumed by document generation, the identity guard, the
 * agent bundle, the extension fill plan and the application worker. Rewriting
 * all of them to read four models each would be a large change to code whose
 * correctness is load-bearing (the identity guard is what stops one person's
 * name reaching another person's résumé). Producing the shape they already
 * expect, from data that is definitively owned, changes ownership without
 * touching that logic.
 *
 * ## What is not here
 *
 * Nothing is invented. A field the user has not filled in is `null`, exactly as
 * it was when the singleton held it — the agent's whole contract is that a null
 * is unanswerable rather than a default, and a projection that helpfully
 * substituted an email address or split a display name into first and last
 * would break that at the source.
 */
export async function applicationProfileForUser(userId: string): Promise<ProfileRow | null> {
  const [profile, preferences, sensitive, education] = await Promise.all([
    prisma.userProfile.findUnique({ where: { userId } }),
    prisma.applicationPreferences.findUnique({ where: { userId } }),
    prisma.sensitiveAnswerPreferences.findUnique({ where: { userId } }),
    // The current or most recent course of study answers a form's "Degree",
    // "Major", "GPA" and "Graduation date" boxes.
    prisma.education.findFirst({ where: { userId }, orderBy: { sortOrder: "asc" } }),
  ]);

  // No profile row and no preferences means this account has entered nothing.
  // That is a real state — a brand-new user — and the callers already handle a
  // null by refusing to fill rather than by guessing.
  if (!profile && !preferences && !sensitive && !education) return null;

  const first = profile?.legalFirstName ?? null;
  const last = profile?.legalLastName ?? null;
  // Composed only when both halves are present. A "full name" built from a
  // first name alone is a wrong answer to a form that asks for a legal name.
  const fullName = first && last ? `${first} ${last}` : null;

  const graduation =
    education?.graduationYear && education?.graduationMonth
      ? `${education.graduationYear}-${education.graduationMonth.padStart(2, "0")}`
      : (education?.graduationYear ?? null);
  const educationStart =
    education?.startYear && education?.startMonth
      ? `${education.startYear}-${education.startMonth.padStart(2, "0")}`
      : (education?.startYear ?? null);

  return {
    fullName,
    legalFirstName: first,
    legalMiddleName: profile?.middleName ?? null,
    // "I have no middle name" is a distinct answer from "not entered", and
    // nothing in the user-owned models records it yet. Null keeps the question
    // open rather than answering it wrongly.
    noMiddleName: null,
    legalLastName: last,
    suffix: null,
    preferredName: profile?.preferredName ?? null,
    pronouns: sensitive?.pronouns ?? null,
    email: profile?.applicationEmail ?? null,
    alternateEmail: profile?.alternateEmail ?? null,
    phone: profile?.phone ?? null,
    phoneCountryCode: profile?.phoneCountryCode ?? null,
    linkedin: profile?.linkedinUrl ?? null,
    github: profile?.githubUrl ?? null,
    website: profile?.portfolioUrl ?? null,
    portfolio: profile?.portfolioUrl ?? null,
    preferredWebsiteField: null,
    school: education?.school ?? null,
    addressStreet: profile?.addressLine1 ?? null,
    addressLine2: profile?.addressLine2 ?? null,
    metroRegion: null,
    addressCity: profile?.city ?? null,
    addressState: profile?.state ?? null,
    addressZip: profile?.postalCode ?? null,
    countryOfResidence: profile?.country ?? null,
    willingToRelocate: preferences?.willingToRelocate ?? null,
    locationPreferences: null,
    internshipTermAvailability: null,
    salaryAnswerPreference: preferences?.salaryPreference ?? null,
    salaryStrategy: null,
    salaryMinimum: null,
    marketingTextConsent: null,
    // Work authorization is a legal answer. It is only stated when the user
    // explicitly said yes or no; an unset preference stays unanswerable.
    workAuthorization:
      preferences?.legallyAuthorizedToWork === true
        ? "Authorized to work in the United States"
        : preferences?.legallyAuthorizedToWork === false
          ? "Not currently authorized to work in the United States"
          : null,
    legallyAuthorizedToWork: preferences?.legallyAuthorizedToWork ?? null,
    requiresSponsorship: preferences?.requiresSponsorshipNow ?? null,
    clearanceEligible: null,
    securityClearanceStatus: preferences?.securityClearanceStatus ?? null,
    // Demographics are used only where the user explicitly chose an answer.
    // `declineDemographics` is a decision to decline, not an answer to report.
    eeoGender: sensitive?.gender ?? null,
    eeoRaceEthnicity: sensitive?.raceEthnicity ?? null,
    eeoVeteranStatus: sensitive?.veteranStatus ?? null,
    eeoDisabilityStatus: sensitive?.disabilityStatus ?? null,
    degreeType: education?.degree ?? null,
    highestDegreeAwarded: null,
    educationLevel: education?.educationLevel ?? null,
    major: education?.major ?? null,
    minor: education?.minor ?? null,
    educationStartDate: educationStart,
    graduationDate: graduation,
    gpa: education?.gpa ?? null,
    gpaScale: null,
    relevantCoursework: education?.relevantCoursework ?? null,
    remotePreference: preferences?.remotePreference ?? null,
    earliestStartDate: preferences?.earliestStartDate ?? null,
    hasDriversLicense: preferences?.hasDriversLicense ?? null,
    meetsMinimumAge: null,
    referralSource: preferences?.usualJobSource ?? null,
    applicationEmail: profile?.applicationEmail ?? null,
    preferredUsername: null,
    wantsAccountCreationHelp: null,
    employerPortalStrategy: null,
    updatedAt: profile?.updatedAt ?? preferences?.updatedAt ?? new Date(),
  };
}
