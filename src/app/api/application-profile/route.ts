import { NextResponse } from "next/server";
import { missingProfileFields } from "@/lib/applications/profileSnapshot";
import { applicationProfileForUser } from "@/lib/profile/applicationProfile";
import { savePersonal, saveApplicationPreferences } from "@/lib/profile/service";
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

/**
 * Saving from the canonical profile form.
 *
 * The incoming body is the old flat shape, and it is split across the two
 * models that own it rather than written to a shared row. Anything the flat
 * shape carries that has no owned home — a suffix, a preferred username — is
 * deliberately dropped rather than stored somewhere it would be readable by
 * another account.
 */
export const POST = withUser(async (req, user) => {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  await savePersonal(user.id, {
    legalFirstName: body.legalFirstName,
    middleName: body.legalMiddleName,
    legalLastName: body.legalLastName,
    preferredName: body.preferredName,
    applicationEmail: body.email ?? body.applicationEmail,
    alternateEmail: body.alternateEmail,
    phone: body.phone,
    phoneCountryCode: body.phoneCountryCode,
    addressLine1: body.addressStreet,
    addressLine2: body.addressLine2,
    city: body.addressCity,
    state: body.addressState,
    postalCode: body.addressZip,
    country: body.countryOfResidence,
    linkedinUrl: body.linkedin,
    githubUrl: body.github,
    portfolioUrl: body.portfolio ?? body.website,
  });

  await saveApplicationPreferences(user.id, {
    willingToRelocate: body.willingToRelocate,
    remotePreference: body.remotePreference,
    earliestStartDate: body.earliestStartDate,
    salaryPreference: body.salaryAnswerPreference,
    hasDriversLicense: body.hasDriversLicense,
    securityClearanceStatus: body.securityClearanceStatus,
    usualJobSource: body.referralSource,
    requiresSponsorshipNow: body.requiresSponsorship,
  });

  return NextResponse.json({ profile: await applicationProfileForUser(user.id) });
});
