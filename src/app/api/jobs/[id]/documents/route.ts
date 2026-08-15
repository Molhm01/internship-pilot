import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withUser } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

/**
 * The tailored documents THIS user generated for this job.
 *
 * The job is shared; the documents are not. Filtering by `jobId` alone returned
 * every applicant’s résumé for the posting.
 */
export const GET = withUser<Params>(async (_req, user, { params }) => {
  const { id } = await params;
  try {
    const startedAt = performance.now();
    const documents = await prisma.generatedDocument.findMany({
      where: { jobId: id, userId: user.id },
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
});
