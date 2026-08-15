import { prisma } from "@/lib/db";
import { readStoredObject } from "@/lib/storage";
import { assertGeneratedDocumentUploadable } from "@/lib/documents/identityGuard";
import { withExtensionUser } from "@/lib/applications/extensionAuth";

type Params = { params: Promise<{ id: string }> };

/**
 * Handing a generated document to the local agent so it can attach it.
 *
 * Four conditions, and all four still apply: the document must be attached to
 * the named run, belong to that run's job, have passed QA, and have passed the
 * identity guard. The fifth is new and is the one this conversion is about —
 * the run and the document must both belong to the user whose extension token
 * this is. Previously any token holder could name any run id and any document
 * id, and the pair only had to be consistent with each other.
 */
export const GET = withExtensionUser<Params>(async (request, userId, { params }) => {
  const { id } = await params;
  const runId = new URL(request.url).searchParams.get("runId");
  if (!runId) {
    return Response.json(
      { error: "A matching ApplicationRun is required before a document can be downloaded." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const run = await prisma.applicationRun.findFirst({ where: { id: runId, userId } });
  if (!run || ![run.resumeDocumentId, run.coverLetterDocumentId].includes(id)) {
    return Response.json(
      { error: "This document is not attached to the requested ApplicationRun." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  const document = await prisma.generatedDocument.findFirst({ where: { id, userId } });
  if (
    !document
    || document.jobId !== run.jobId
    || document.qaStatus !== "pass"
    || !document.identityVerified
  ) {
    return Response.json(
      { error: "The requested document is not job-specific, QA-passed, and identity-verified." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    await assertGeneratedDocumentUploadable(document.id);
    const bytes = await readStoredObject(document.storagePath);
    return new Response(bytes, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${document.type === "resume" ? "resume" : "cover-letter"}.pdf"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The document could not be safely opened." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
});
