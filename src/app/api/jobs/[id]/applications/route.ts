import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withUser } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

/**
 * This user’s application attempts against this job. An application run holds
 * every answer that was submitted to the employer, so it is as private as the
 * profile it was filled from.
 */
export const GET = withUser<Params>(async (_req, user, { params }) => {
  const { id } = await params;
  const startedAt = performance.now();
  const runs = await prisma.applicationRun.findMany({
    where: { jobId: id, userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  if (process.env.NODE_ENV === "development") {
    console.info(JSON.stringify({
      event: "job-page-db-timing",
      operation: "application-run-history",
      jobId: id,
      durationMs: Math.round(performance.now() - startedAt),
    }));
  }
  return NextResponse.json({ runs });
});
