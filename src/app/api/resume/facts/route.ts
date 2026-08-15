import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { FACT_TYPES } from "@/lib/statuses";
import { withUser } from "@/lib/auth/session";

/**
 * Résumé facts belong to the person whose résumé they came from.
 *
 * Both handlers take their owner from the session and nowhere else. There is no
 * `userId` parameter to tamper with, and the list query cannot be widened by a
 * query string: `status` filters within one user's rows, never across users.
 */
export const GET = withUser(async (request, user) => {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");

  const facts = await prisma.resumeFact.findMany({
    where: { userId: user.id, ...(status ? { status } : {}) },
    orderBy: [{ type: "asc" }, { createdAt: "asc" }],
  });

  return NextResponse.json({ facts });
});

type IncomingFact = {
  type: string;
  content: string;
  detail?: string | null;
  source?: string;
};

export const POST = withUser(async (request, user) => {
  const body = await request.json().catch(() => null);
  const items: IncomingFact[] | null = Array.isArray(body?.facts) ? body.facts : null;

  if (!items || items.length === 0) {
    return NextResponse.json({ error: "facts array is required" }, { status: 400 });
  }

  for (const item of items) {
    if (!FACT_TYPES.includes(item?.type as (typeof FACT_TYPES)[number])) {
      return NextResponse.json({ error: `Invalid fact type: ${item?.type}` }, { status: 400 });
    }
    if (typeof item?.content !== "string" || !item.content.trim()) {
      return NextResponse.json({ error: "Every fact needs non-empty content" }, { status: 400 });
    }
  }

  const created = await prisma.$transaction(
    items.map((item) =>
      prisma.resumeFact.create({
        data: {
          userId: user.id,
          type: item.type,
          content: item.content.trim(),
          detail: item.detail?.trim() || null,
          status: "approved",
          source: item.source === "manual" ? "manual" : "ai",
        },
      }),
    ),
  );

  return NextResponse.json({ facts: created }, { status: 201 });
});
