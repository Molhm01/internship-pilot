import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const startedAt = performance.now();
    const documents = await prisma.generatedDocument.findMany({
      where: { jobId: id },
      orderBy: [{ type: "asc" }, { version: "desc" }],
    });
    if (process.env.NODE_ENV === "development") {
      console.info(JSON.stringify({
        event: "job-page-db-timing",
        operation: "tailored-document-metadata",
        jobId: id,
        durationMs: Math.round(performance.now() - startedAt),
      }));
    }
    return NextResponse.json({ documents }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Failed to load generated documents.", { jobId: id, error });
    return NextResponse.json(
      { error: "Saved tailored documents could not be loaded." },
      { status: 500 },
    );
  }
}
