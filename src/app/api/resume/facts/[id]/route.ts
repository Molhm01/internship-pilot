import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { FACT_TYPES } from "@/lib/statuses";
import { notFoundResponse, withUser } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

/**
 * By-id routes check two things, always in this order: the row exists, and it
 * belongs to the caller. A `findUnique` on the id alone answers "does this
 * exist" for the whole installation, which is the shape of every by-id
 * cross-account read — so the owner is part of the query, not a check after it.
 *
 * `updateMany`/`deleteMany` with both keys is how the write stays atomic: a
 * read-then-write leaves a window, and a count of 0 is an unambiguous "not
 * yours or not there".
 */
export const PATCH = withUser<Params>(async (request, user, { params }) => {
  const { id } = await params;
  const body = await request.json().catch(() => null);
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

  const updated = await prisma.resumeFact.updateMany({ where: { id, userId: user.id }, data });
  if (updated.count === 0) return notFoundResponse("Fact not found");

  const fact = await prisma.resumeFact.findFirst({ where: { id, userId: user.id } });
  return NextResponse.json({ fact });
});

export const DELETE = withUser<Params>(async (_request, user, { params }) => {
  const { id } = await params;
  const deleted = await prisma.resumeFact.deleteMany({ where: { id, userId: user.id } });
  if (deleted.count === 0) return notFoundResponse("Fact not found");
  return NextResponse.json({ ok: true });
});
