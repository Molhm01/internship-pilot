import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { companyKey } from "@/lib/applications/profileSnapshot";

/**
 * What the applicant knows about one employer.
 *
 * Every field is a tri-state. `null` is stored for "I have not said", and the
 * agent turns that into a question rather than an answer — which is the whole
 * reason these are per-company rows instead of profile-wide booleans. There is
 * no honest default for "have you worked here before".
 */

function tristate(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "yes") return true;
  if (value === "no") return false;
  return null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export async function GET(request: Request) {
  const company = new URL(request.url).searchParams.get("company")?.trim();
  if (!company) {
    const all = await prisma.companyRelationshipFact.findMany({ orderBy: { companyName: "asc" } });
    return NextResponse.json({ facts: all }, { headers: { "cache-control": "no-store" } });
  }
  const fact = await prisma.companyRelationshipFact.findUnique({
    where: { companyKey: companyKey(company) },
  });
  return NextResponse.json({ fact }, { headers: { "cache-control": "no-store" } });
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });

  const companyName = text(body.companyName);
  if (!companyName) {
    return NextResponse.json(
      { error: "A company name is required.", field: "companyName" },
      { status: 422 },
    );
  }

  const overrides =
    body.overrides && typeof body.overrides === "object" && !Array.isArray(body.overrides)
      ? JSON.stringify(
          Object.fromEntries(
            Object.entries(body.overrides as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
        )
      : null;

  const data = {
    companyName,
    previouslyEmployed: tristate(body.previouslyEmployed),
    previouslyInterviewed: tristate(body.previouslyInterviewed),
    previouslyApplied: tristate(body.previouslyApplied),
    familyMemberEmployed: tristate(body.familyMemberEmployed),
    hasReferral: tristate(body.hasReferral),
    referralName: text(body.referralName),
    referralEmail: text(body.referralEmail),
    referralRelationship: text(body.referralRelationship),
    overrides,
  };

  const key = companyKey(companyName);
  const fact = await prisma.companyRelationshipFact.upsert({
    where: { companyKey: key },
    update: data,
    create: { companyKey: key, ...data },
  });
  return NextResponse.json({ fact });
}

export async function DELETE(request: Request) {
  const company = new URL(request.url).searchParams.get("company")?.trim();
  if (!company) return NextResponse.json({ error: "Name a company." }, { status: 400 });
  await prisma.companyRelationshipFact
    .delete({ where: { companyKey: companyKey(company) } })
    .catch(() => undefined);
  return NextResponse.json({ ok: true });
}
