import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const profile = await prisma.applicationProfile.findUnique({ where: { id: "default" } });
  return NextResponse.json({ profile });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const data = {
    fullName: body.fullName?.trim() || null,
    preferredName: body.preferredName?.trim() || null,
    email: body.email?.trim() || null,
    phone: body.phone?.trim() || null,
    linkedin: body.linkedin?.trim() || null,
    github: body.github?.trim() || null,
    website: body.website?.trim() || null,
    school: body.school?.trim() || null,
    previousSchool: body.previousSchool?.trim() || null,
    addressStreet: body.addressStreet?.trim() || null,
    addressCity: body.addressCity?.trim() || null,
    addressState: body.addressState?.trim() || null,
    addressZip: body.addressZip?.trim() || null,
    countryOfResidence: body.countryOfResidence?.trim() || null,
    willingToRelocate: typeof body.willingToRelocate === "boolean" ? body.willingToRelocate : null,
    locationPreferences: Array.isArray(body.locationPreferences) ? JSON.stringify(body.locationPreferences) : null,
    internshipTermAvailability: body.internshipTermAvailability?.trim() || null,
    salaryAnswerPreference: body.salaryAnswerPreference?.trim() || null,
    // Milestone 6: left null unless the user explicitly sets them — null
    // means the application agent must stop and ask rather than guess.
    workAuthorization: body.workAuthorization?.trim() || null,
    requiresSponsorship: typeof body.requiresSponsorship === "boolean" ? body.requiresSponsorship : null,
    clearanceEligible: typeof body.clearanceEligible === "boolean" ? body.clearanceEligible : null,
    eeoGender: body.eeoGender?.trim() || null,
    eeoRaceEthnicity: body.eeoRaceEthnicity?.trim() || null,
    eeoVeteranStatus: body.eeoVeteranStatus?.trim() || null,
    eeoDisabilityStatus: body.eeoDisabilityStatus?.trim() || null,
    legalFirstName: body.legalFirstName?.trim() || null,
    legalMiddleName: body.legalMiddleName?.trim() || null,
    legalLastName: body.legalLastName?.trim() || null,
    pronouns: body.pronouns?.trim() || null,
    alternateEmail: body.alternateEmail?.trim() || null,
    phoneCountryCode: body.phoneCountryCode?.trim() || null,
    portfolio: body.portfolio?.trim() || null,
    degreeType: body.degreeType?.trim() || null,
    educationLevel: body.educationLevel?.trim() || null,
    major: body.major?.trim() || null,
    minor: body.minor?.trim() || null,
    educationStartDate: body.educationStartDate?.trim() || null,
    graduationDate: body.graduationDate?.trim() || null,
    gpa: body.gpa?.trim() || null,
    gpaScale: body.gpaScale?.trim() || null,
    remotePreference: body.remotePreference?.trim() || null,
    earliestStartDate: body.earliestStartDate?.trim() || null,
    referralSource: body.referralSource?.trim() || null,
    applicationEmail: body.applicationEmail?.trim() || null,
    preferredUsername: body.preferredUsername?.trim() || null,
    hasDriversLicense: typeof body.hasDriversLicense === "boolean" ? body.hasDriversLicense : null,
    meetsMinimumAge: typeof body.meetsMinimumAge === "boolean" ? body.meetsMinimumAge : null,
    wantsAccountCreationHelp: typeof body.wantsAccountCreationHelp === "boolean" ? body.wantsAccountCreationHelp : null,
    relevantCoursework: Array.isArray(body.relevantCoursework) ? JSON.stringify(body.relevantCoursework) : null,
  };

  const profile = await prisma.applicationProfile.upsert({
    where: { id: "default" },
    update: data,
    create: { id: "default", ...data },
  });

  return NextResponse.json({ profile });
}
