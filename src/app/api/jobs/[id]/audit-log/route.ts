import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withUser } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

/**
 * The activity timeline for one job.
 *
 * Global events about the posting — discovery, verification — carry no owner
 * and are shown to everyone. Everything a person did (applied, generated a
 * document, matched an email) carries theirs, and only they see it.
 */
export const GET = withUser<Params>(async (_req, user, { params }) => {
  const { id } = await params;
  const startedAt = performance.now();
  const entries = await prisma.auditLogEntry.findMany({
    where: { jobId: id, OR: [{ userId: null }, { userId: user.id }] },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  if (process.env.NODE_ENV === "development") {
    console.info(JSON.stringify({
      event: "job-page-db-timing",
      operation: "activity-timeline",
      jobId: id,
      durationMs: Math.round(performance.now() - startedAt),
    }));
  }
  return NextResponse.json({ entries });
});
