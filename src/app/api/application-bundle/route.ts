import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  buildAccountPreferences,
  buildProfileSnapshot,
  missingProfileFields,
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
 * No password or credential is read, returned, or logged here.
 */
export async function GET() {
  const row = await prisma.applicationProfile.findUnique({ where: { id: "default" } });
  if (!row) {
    return NextResponse.json(
      { error: "No application profile has been saved yet. Fill in the Profile page first." },
      { status: 404 },
    );
  }

  const [facts, answers] = await Promise.all([
    prisma.resumeFact.findMany({ where: { status: { in: ["approved", "edited"] } } }),
    prisma.approvedAnswer.findMany({ orderBy: { updatedAt: "desc" }, take: 500 }),
  ]);

  const profileRow = row as unknown as ProfileRow;
  return NextResponse.json(
    {
      profile: buildProfileSnapshot(profileRow, facts),
      accountPreferences: buildAccountPreferences(profileRow),
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
