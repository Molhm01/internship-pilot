import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { missingProfileFields } from "@/lib/applications/profileSnapshot";
import { applicationProfileForUser } from "@/lib/profile/applicationProfile";
import { text, tristate, educationData } from "@/lib/profile/service";
import { withUser } from "@/lib/auth/session";

/**
 * The application profile the agent fills employer forms from.
 *
 * There is no longer a row behind this. It used to read `ApplicationProfile`,
 * a singleton keyed `"default"` — one person's legal name, address, phone and
 * demographic answers, returned to whoever asked. It is now assembled per user
 * from the models that own those facts; see
 * `src/lib/profile/applicationProfile.ts`.
 *
 * `gaps` is returned alongside so the Profile page can show what an employer
 * form will still be unable to answer, before the user reaches one.
 */
export const GET = withUser(async (_request, user) => {
  const profile = await applicationProfileForUser(user.id);
  return NextResponse.json(
    {
      profile,
      gaps: profile ? missingProfileFields(profile) : [],
    },
    { headers: { "cache-control": "no-store" } },
  );
});

/** "YYYY-MM" -> the separate month/year strings Education stores. Anything else is unanswered. */
function splitMonthYear(value: unknown): { month: string | null; year: string | null } {
  if (typeof value !== "string") return { month: null, year: null };
  const match = value.trim().match(/^(\d{4})-(\d{2})$/);
  return match ? { year: match[1], month: match[2] } : { month: null, year: null };
}

/**
 * Saving from the canonical profile form.
 *
 * The incoming body is the old flat shape, split across the four models that
 * own it (UserProfile, ApplicationPreferences, SensitiveAnswerPreferences, and
 * the user's primary Education row) rather than written to a shared row.
 *
 * Every field this form renders as editable is either persisted here or
 * disabled in the form with an explanation — see CanonicalProfileForm.tsx.
 * Nothing the form accepts is silently dropped.
 *
 * All four writes go in a single transaction: either the whole profile save
 * lands, or none of it does. A user reading "Saved" after a partial write
 * (UserProfile updated but Education silently unchanged) would apply to a
 * real employer form on data the UI told them was current.
 */
export const POST = withUser(async (req, user) => {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  // The "Application email" box is the authoritative answer whenever the user
  // has filled it in. "Everyday email" is only ever a fallback SOURCE for it —
  // never allowed to override an explicit Application email the user just
  // typed, which is what made this box appear to silently revert itself.
  const applicationEmail = text(body.applicationEmail) ?? text(body.email);

  const personalData = {
    legalFirstName: text(body.legalFirstName),
    middleName: text(body.legalMiddleName),
    legalLastName: text(body.legalLastName),
    preferredName: text(body.preferredName),
    applicationEmail,
    alternateEmail: text(body.alternateEmail),
    phone: text(body.phone),
    phoneCountryCode: text(body.phoneCountryCode),
    addressLine1: text(body.addressStreet),
    addressLine2: text(body.addressLine2),
    city: text(body.addressCity),
    state: text(body.addressState),
    postalCode: text(body.addressZip),
    country: text(body.countryOfResidence),
    linkedinUrl: text(body.linkedin),
    githubUrl: text(body.github),
    portfolioUrl: text(body.portfolio) ?? text(body.website),
  };

  const preferencesData = {
    // An explicit tri-state control, never inferred from free text. See
    // CanonicalProfileForm.tsx — "Legally authorized to work in the United
    // States?" offers Not answered / Yes / No and nothing else.
    legallyAuthorizedToWork: tristate(body.legallyAuthorizedToWork),
    requiresSponsorshipNow: tristate(body.requiresSponsorship),
    willingToRelocate: tristate(body.willingToRelocate),
    remotePreference: text(body.remotePreference),
    earliestStartDate: text(body.earliestStartDate),
    salaryPreference: text(body.salaryAnswerPreference),
    hasDriversLicense: tristate(body.hasDriversLicense),
    securityClearanceStatus: text(body.securityClearanceStatus),
    usualJobSource: text(body.referralSource),
  };

  // declineDemographics is owned by a separate dedicated control (see
  // /api/profile/sensitive) that this form does not render. Carrying the
  // existing value forward — rather than defaulting it — means a canonical
  // profile save can never silently flip it back to the "decline" default.
  const existingSensitive = await prisma.sensitiveAnswerPreferences.findUnique({ where: { userId: user.id } });
  const sensitiveData = {
    gender: text(body.eeoGender),
    raceEthnicity: text(body.eeoRaceEthnicity),
    veteranStatus: text(body.eeoVeteranStatus),
    disabilityStatus: text(body.eeoDisabilityStatus),
    pronouns: text(body.pronouns),
    declineDemographics: existingSensitive?.declineDemographics ?? true,
  };

  // Education is a multi-row list (see /api/profile/education) that this form
  // edits only one row of: the primary/current entry, deterministically the
  // lowest-sortOrder row — the same row applicationProfileForUser() already
  // reads as "the" education for form-filling. A blank School means the user
  // has not started this section, so no row is created for it; an empty
  // required `school` column is worse than no row at all.
  const schoolValue = text(body.school);
  let educationWrite: ReturnType<typeof prisma.education.update> | ReturnType<typeof prisma.education.create> | null = null;
  if (schoolValue) {
    const primary = await prisma.education.findFirst({
      where: { userId: user.id },
      orderBy: { sortOrder: "asc" },
    });
    const start = splitMonthYear(body.educationStartDate);
    const graduation = splitMonthYear(body.graduationDate);
    const data = educationData({
      school: body.school,
      degree: body.degreeType,
      major: body.major,
      minor: body.minor,
      startMonth: start.month,
      startYear: start.year,
      graduationMonth: graduation.month,
      graduationYear: graduation.year,
      gpa: body.gpa,
      educationLevel: body.educationLevel,
      relevantCoursework: body.relevantCoursework,
      sortOrder: primary?.sortOrder ?? 0,
    });
    educationWrite = primary
      ? prisma.education.update({ where: { id: primary.id }, data })
      : prisma.education.create({ data: { userId: user.id, ...data } });
  }

  try {
    await prisma.$transaction([
      prisma.userProfile.upsert({ where: { userId: user.id }, update: personalData, create: { userId: user.id, ...personalData } }),
      prisma.applicationPreferences.upsert({ where: { userId: user.id }, update: preferencesData, create: { userId: user.id, ...preferencesData } }),
      prisma.sensitiveAnswerPreferences.upsert({ where: { userId: user.id }, update: sensitiveData, create: { userId: user.id, ...sensitiveData } }),
      ...(educationWrite ? [educationWrite] : []),
    ]);
  } catch {
    return NextResponse.json({ error: "The profile could not be saved. Nothing was changed." }, { status: 500 });
  }

  const saved = await applicationProfileForUser(user.id);
  return NextResponse.json({ profile: saved, gaps: saved ? missingProfileFields(saved) : [] });
});
