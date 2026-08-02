import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { FACT_TYPES } from "@/lib/statuses";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");

  const facts = await prisma.resumeFact.findMany({
    where: status ? { status } : undefined,
    orderBy: [{ type: "asc" }, { createdAt: "asc" }],
  });

  return NextResponse.json({ facts });
}

type IncomingFact = {
  type: string;
  content: string;
  detail?: string | null;
  source?: string;
};

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
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
}
