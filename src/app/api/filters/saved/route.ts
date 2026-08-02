import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const DEFAULT_FILTER_NAME = "Molhm Engineering Internships";

// Electrical, hardware, embedded, electronics, testing, controls,
// semiconductor and manufacturing/test roles; Clifton/North Jersey/NYC area
// or remote; a separate relocation toggle; verified and currently open only.
const DEFAULT_FILTER = {
  disciplines: [
    "electrical",
    "hardware",
    "embedded",
    "electronics",
    "test",
    "controls",
    "semiconductor",
    "manufacturing",
  ],
  maxDistanceMiles: 60,
  includeRemoteRegardlessOfDistance: true,
  relocationWillingness: false,
  // Verified-only is enforced globally by the Jobs page now (Milestone 3);
  // no per-preset flag needed any more.
};

async function ensureDefaultFilter() {
  await prisma.savedFilter.upsert({
    where: { name: DEFAULT_FILTER_NAME },
    update: {},
    create: { name: DEFAULT_FILTER_NAME, filterJson: JSON.stringify(DEFAULT_FILTER) },
  });
}

export async function GET() {
  await ensureDefaultFilter();
  const filters = await prisma.savedFilter.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json({ filters });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body?.name?.trim() || !body?.filter) {
    return NextResponse.json({ error: "name and filter are required" }, { status: 400 });
  }
  const filter = await prisma.savedFilter.upsert({
    where: { name: body.name.trim() },
    update: { filterJson: JSON.stringify(body.filter) },
    create: { name: body.name.trim(), filterJson: JSON.stringify(body.filter) },
  });
  return NextResponse.json({ filter }, { status: 201 });
}
