import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const companies = await prisma.company.findMany({
    orderBy: [{ priority: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({ companies });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body?.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  try {
    const company = await prisma.company.create({
      data: {
        name: body.name.trim(),
        industry: body.industry?.trim() || null,
        website: body.website?.trim() || null,
        careersUrl: body.careersUrl?.trim() || null,
        atsType: body.atsType?.trim() || "unknown",
        atsIdentifier: body.atsIdentifier?.trim() || null,
        locations: body.locations ? JSON.stringify(body.locations) : null,
        priority: ["priority", "standard", "low"].includes(body.priority) ? body.priority : "standard",
        source: "manual",
      },
    });
    return NextResponse.json({ company }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "A company with that name already exists." }, { status: 409 });
  }
}
