import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const startedAt = performance.now();
  const runs = await prisma.applicationRun.findMany({
    where: { jobId: id },
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
}
