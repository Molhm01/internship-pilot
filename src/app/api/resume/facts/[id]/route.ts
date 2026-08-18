import { after, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { FACT_TYPES } from "@/lib/statuses";
import { notFoundResponse, withUser } from "@/lib/auth/session";
import { scheduleAutomaticScoresForUser } from "@/lib/matching/automaticScoring";

type Params = { params: Promise<{ id: string }> };

function queueRefreshAfterProfileChange(userId: string) {
  after(async () => {
    try {
      await scheduleAutomaticScoresForUser(userId);
    } catch (error) {
      console.error("[resume-fact] automatic score scheduling failed", {
        userId,
        errorCode:
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "AUTOMATIC_SCORE_QUEUE_FAILED",
      });
    }
  });
}

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
  queueRefreshAfterProfileChange(user.id);
  return NextResponse.json({ fact });
});

export const DELETE = withUser<Params>(async (_request, user, { params }) => {
  const { id } = await params;
  const deleted = await prisma.resumeFact.deleteMany({ where: { id, userId: user.id } });
  if (deleted.count === 0) return notFoundResponse("Fact not found");
  queueRefreshAfterProfileChange(user.id);
  return NextResponse.json({ ok: true });
});
