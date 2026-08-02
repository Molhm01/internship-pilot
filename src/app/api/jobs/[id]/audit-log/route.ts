import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const startedAt = performance.now();
  const entries = await prisma.auditLogEntry.findMany({
    where: { jobId: id },
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
}
