import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { experienceData, resolveProfileOwner } from "@/lib/profile/service";

/** Adds one Experience entry. Several may exist; each is edited on its own. */
export async function POST(request: Request) {
  const owner = await resolveProfileOwner();
  if (owner === undefined) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });

  const data = experienceData(body);
  const requiredField = Object.entries(data).find(
    ([key, value]) => (key === "school" || key === "employer" || key === "name") && !value,
  );
  if (requiredField) {
    return NextResponse.json(
      { error: `${requiredField[0]} is required.`, field: requiredField[0] },
      { status: 422 },
    );
  }
  const created = await prisma.experience.create({ data: { userId: owner, ...data } });
  return NextResponse.json({ entry: created }, { status: 201 });
}
