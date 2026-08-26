import { prisma } from "@/lib/db";
import { applicationProfileForUser } from "@/lib/profile/applicationProfile";
import { companyKey } from "./profileSnapshot";
import type { FillContext } from "./types";

function parseStringList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The evidence longAnswer.ts is allowed to draw from: every approved
 * Experience/Project entry (the exact same "approved" fields
 * ProfileEntriesSection writes), plus this specific employer's relationship
 * facts. Fetched fresh per run rather than cached, same as the rest of
 * FillContext — the agent must never fill from a stale copy of what the user
 * approved.
 */
export async function longAnswerFactsForUser(
  userId: string,
  company: string,
): Promise<Pick<FillContext, "approvedExperiences" | "approvedProjects" | "companyRelationship">> {
  const [experiences, projects, relationship] = await Promise.all([
    prisma.experience.findMany({ where: { userId }, orderBy: { sortOrder: "asc" } }),
    prisma.project.findMany({ where: { userId }, orderBy: { sortOrder: "asc" } }),
    prisma.companyRelationshipFact.findUnique({
      where: { userId_companyKey: { userId, companyKey: companyKey(company) } },
    }),
  ]);
  return {
    approvedExperiences: experiences.map((entry) => ({
      employer: entry.employer,
      title: entry.title,
      approvedBullets: parseStringList(entry.approvedBullets),
    })),
    approvedProjects: projects.map((entry) => ({
      name: entry.name,
      description: entry.description,
      approvedSkills: parseStringList(entry.approvedSkills),
    })),
    companyRelationship: relationship
      ? {
          hasReferral: relationship.hasReferral,
          referralName: relationship.referralName,
          referralRelationship: relationship.referralRelationship,
          familyMemberEmployed: relationship.familyMemberEmployed,
        }
      : null,
  };
}

type ProfileRow = NonNullable<Awaited<ReturnType<typeof applicationProfileForUser>>>;

/**
 * The profile half of a `FillContext`, built from one user's own profile.
 *
 * This existed twice — once in the background worker and once in the extension
 * API — and the two copies are what the agent actually types into an employer's
 * form. Two copies of that mapping is two places for one person's answer to
 * drift away from the other, so it lives here and both callers import it.
 */
export function fillContextProfile(profile: ProfileRow): FillContext["profile"] {
  let locationPreferences: string[] | null = null;
  try {
    const parsed = JSON.parse(profile.locationPreferences ?? "null");
    locationPreferences = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : null;
  } catch {
    locationPreferences = null;
  }
  return {
    fullName: profile.fullName,
    preferredName: profile.preferredName,
    email: profile.email,
    phone: profile.phone,
    linkedin: profile.linkedin,
    github: profile.github,
    website: profile.website,
    school: profile.school,
    // Not carried by the user-owned profile. Null is the honest answer: the
    // agent asks rather than filling a school the applicant never entered.
    previousSchool: null,
    addressStreet: profile.addressStreet,
    addressCity: profile.addressCity,
    addressState: profile.addressState,
    addressZip: profile.addressZip,
    countryOfResidence: profile.countryOfResidence,
    willingToRelocate: profile.willingToRelocate,
    locationPreferences,
    internshipTermAvailability: profile.internshipTermAvailability,
    earliestStartDate: profile.earliestStartDate,
    salaryAnswerPreference: profile.salaryAnswerPreference,
    workAuthorization: profile.workAuthorization,
    requiresSponsorship: profile.requiresSponsorship,
    clearanceEligible: profile.clearanceEligible,
    eeoGender: profile.eeoGender,
    eeoRaceEthnicity: profile.eeoRaceEthnicity,
    eeoVeteranStatus: profile.eeoVeteranStatus,
    eeoDisabilityStatus: profile.eeoDisabilityStatus,
  };
}

/**
 * The degree and most recent role the agent may state on this user's behalf.
 *
 * Both fields used to come from `MASTER_EDUCATION[0]` and `MASTER_EXPERIENCE[0]`
 * — module constants holding one specific person's real degree and job history,
 * transcribed from their résumé. Every signed-in account's fill context and
 * every extension payload carried those two facts, so the agent would have
 * typed one applicant's degree into another applicant's form. They are read
 * from the asking user's own `Education` and `Experience` rows instead.
 *
 * A user who has entered neither gets nulls, which the field classifier already
 * treats as unanswerable — the agent pauses rather than inventing a degree.
 */
export async function applicationNarrativeForUser(
  userId: string,
): Promise<{ educationDegree: string | null; recentExperience: string | null }> {
  const [education, experience] = await Promise.all([
    prisma.education.findFirst({ where: { userId }, orderBy: { sortOrder: "asc" } }),
    // `sortOrder` is the order the user arranged their own history in, and the
    // first entry is the one they put forward as most recent.
    prisma.experience.findFirst({ where: { userId }, orderBy: { sortOrder: "asc" } }),
  ]);
  const recentExperience = experience
    ? [experience.title, experience.employer].filter((part): part is string => Boolean(part && part.trim())).join(" — ") || null
    : null;
  return {
    educationDegree: education?.degree ?? null,
    recentExperience,
  };
}
