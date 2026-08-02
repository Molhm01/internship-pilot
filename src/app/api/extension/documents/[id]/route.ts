import path from "node:path";
import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/db";
import { assertGeneratedDocumentUploadable } from "@/lib/documents/identityGuard";
import {
  extensionUnauthorizedResponse,
  isExtensionRequestAuthorized,
} from "@/lib/applications/extensionAuth";

function absolutePath(storagePath: string): string {
  return path.isAbsolute(storagePath)
    ? storagePath
    : path.join(/* turbopackIgnore: true */ process.cwd(), storagePath);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isExtensionRequestAuthorized(request))) return extensionUnauthorizedResponse();
  const { id } = await params;
  const runId = new URL(request.url).searchParams.get("runId");
  if (!runId) {
    return Response.json(
      { error: "A matching ApplicationRun is required before a document can be downloaded." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const run = await prisma.applicationRun.findUnique({ where: { id: runId } });
  if (!run || ![run.resumeDocumentId, run.coverLetterDocumentId].includes(id)) {
    return Response.json(
      { error: "This document is not attached to the requested ApplicationRun." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  const document = await prisma.generatedDocument.findUnique({ where: { id } });
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
    const bytes = await readFile(absolutePath(document.storagePath));
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
}
