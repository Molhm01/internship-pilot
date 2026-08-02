import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  buildAccountPreferences,
  buildCompanyRelationship,
  buildProfileSnapshot,
  companyKey,
  missingProfileFields,
  PROFILE_SNAPSHOT_VERSION,
  type CompanyRelationshipRow,
  type ProfileRow,
} from "@/lib/applications/profileSnapshot";

/**
 * The profile half of the application bundle.
 *
 * The browser asks for this immediately before handing a bundle to the
 * extension, so what the extension receives is whatever the user has saved
 * right now rather than a copy that drifted. Approved answers travel with it,
 * because an answer the user already wrote is preferable to anything a model
 * would compose.
 *
 * `?company=` scopes the company-relationship facts. When the user has said
 * nothing about that employer the key is absent rather than filled with
 * negatives — "we do not know" has to reach the extension intact so it can ask
 * instead of answering "have you worked here before" out of thin air.
 *
 * No password or credential is read, returned, or logged here.
 */
export async function GET(request: Request) {
  const row = await prisma.applicationProfile.findUnique({ where: { id: "default" } });
  if (!row) {
    return NextResponse.json(
      { error: "No application profile has been saved yet. Fill in the Profile page first." },
      { status: 404 },
    );
  }

  const company = new URL(request.url).searchParams.get("company")?.trim();

  const [facts, answers, experiences, projects, educations, relationship] = await Promise.all([
    prisma.resumeFact.findMany({ where: { status: { in: ["approved", "edited"] } } }),
    prisma.approvedAnswer.findMany({ orderBy: { updatedAt: "desc" }, take: 500 }),
    prisma.experience.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.project.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.education.findMany({ orderBy: { sortOrder: "asc" } }),
    company
      ? prisma.companyRelationshipFact.findUnique({ where: { companyKey: companyKey(company) } })
      : Promise.resolve(null),
  ]);

  const profileRow = row as unknown as ProfileRow;
  const companyRelationship = buildCompanyRelationship(
    relationship as CompanyRelationshipRow | null,
  );

  return NextResponse.json(
    {
      bundleVersion: PROFILE_SNAPSHOT_VERSION,
      profile: buildProfileSnapshot(profileRow, { facts, experiences, projects, educations }),
      accountPreferences: buildAccountPreferences(profileRow),
      ...(companyRelationship ? { companyRelationship } : {}),
      approvedAnswers: answers.map((answer) => ({
        id: answer.id,
        canonicalQuestion: answer.questionText,
        normalizedQuestion: answer.questionText.toLowerCase().replace(/\s+/g, " ").trim(),
        aliases: [],
        answerType: "text",
        answer: answer.answer,
        approved: true,
        autoFillAllowed: true,
        sensitive: false,
        tailoringAllowed: true,
        requiresReview: false,
        evidenceReferences: [],
        scope: "general",
        createdAt: answer.createdAt.toISOString(),
        updatedAt: answer.updatedAt.toISOString(),
      })),
      missingFields: missingProfileFields(profileRow),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
