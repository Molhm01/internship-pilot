import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { FACT_TYPES } from "@/lib/statuses";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const data: Record<string, unknown> = {};
  if (typeof body.content === "string") {
    if (!body.content.trim()) {
      return NextResponse.json({ error: "content cannot be empty" }, { status: 400 });
    }
    data.content = body.content.trim();
    data.source = "edited";
  }
  if (typeof body.detail === "string" || body.detail === null) {
    data.detail = body.detail?.trim?.() || null;
  }
  if (typeof body.type === "string") {
    if (!FACT_TYPES.includes(body.type as (typeof FACT_TYPES)[number])) {
      return NextResponse.json({ error: `Invalid fact type: ${body.type}` }, { status: 400 });
    }
    data.type = body.type;
  }
  if (typeof body.status === "string") {
    if (!["pending", "approved", "edited", "rejected"].includes(body.status)) {
      return NextResponse.json({ error: `Invalid status: ${body.status}` }, { status: 400 });
    }
    data.status = body.status;
  }

  try {
    const fact = await prisma.resumeFact.update({ where: { id }, data });
    return NextResponse.json({ fact });
  } catch {
    return NextResponse.json({ error: "Fact not found" }, { status: 404 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await prisma.resumeFact.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Fact not found" }, { status: 404 });
  }
}
