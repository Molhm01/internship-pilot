import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withUser } from "@/lib/auth/session";

// Not exported: a Next route module may only export route handlers and route
// config, and `next build` type-checks that contract against its generated
// route types.
const DEFAULT_FILTER_NAME = "Engineering internships";

// Electrical, hardware, embedded, electronics, testing, controls,
// semiconductor and manufacturing/test roles; a 60-mile radius with remote
// included; a separate relocation toggle.
//
// This is a *starting point* offered to a new account, not a description of
// anybody. It used to be named after the original user and created once
// globally, which in a hosted deployment would greet every new signup with a
// stranger's saved search.
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

/**
 * Seeds this user's starter preset, once.
 *
 * `createMany … skipDuplicates` rather than `upsert`: two tabs opening the Jobs
 * page at the same moment both find nothing and both insert, and the unique
 * index on (userId, name) is what makes the second one a no-op instead of a
 * 500.
 */
async function ensureDefaultFilter(userId: string): Promise<void> {
  await prisma.savedFilter.createMany({
    data: [{ userId, name: DEFAULT_FILTER_NAME, filterJson: JSON.stringify(DEFAULT_FILTER) }],
    skipDuplicates: true,
  });
}

export const GET = withUser(async (_request, user) => {
  await ensureDefaultFilter(user.id);
  const filters = await prisma.savedFilter.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ filters });
});

export const POST = withUser(async (request, user) => {
  const body = await request.json().catch(() => null);
  if (!body?.name?.trim() || !body?.filter) {
    return NextResponse.json({ error: "name and filter are required" }, { status: 400 });
  }
  const name = String(body.name).trim().slice(0, 200);
  // Scoped by the compound key, so saving a filter called "Remote" cannot
  // overwrite another account's filter of the same name.
  const filter = await prisma.savedFilter.upsert({
    where: { userId_name: { userId: user.id, name } },
    update: { filterJson: JSON.stringify(body.filter) },
    create: { userId: user.id, name, filterJson: JSON.stringify(body.filter) },
  });
  return NextResponse.json({ filter }, { status: 201 });
});
