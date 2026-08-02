import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resolveProfileOwner } from "@/lib/profile/service";

/**
 * The multi-row halves of the profile: work history, projects, and any
 * education beyond the primary entry that lives on `ApplicationProfile`.
 *
 * These are separate rows rather than more columns because an application form
 * asks for an employer, a title and two dates as four distinct answers, and one
 * line of résumé prose cannot be split into them without guessing.
 */
export async function GET() {
  const owner = await resolveProfileOwner();
  if (owner === undefined) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const [experiences, projects, educations] = await Promise.all([
    prisma.experience.findMany({ where: { userId: owner }, orderBy: { sortOrder: "asc" } }),
    prisma.project.findMany({ where: { userId: owner }, orderBy: { sortOrder: "asc" } }),
    prisma.education.findMany({ where: { userId: owner }, orderBy: { sortOrder: "asc" } }),
  ]);

  return NextResponse.json(
    { experiences, projects, educations },
    { headers: { "cache-control": "no-store" } },
  );
}
