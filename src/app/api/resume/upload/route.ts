import { after, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { extractPdfText, hasPdfMagicBytes, MAX_PDF_SIZE_BYTES, PdfExtractionError } from "@/lib/pdf";
import { saveResumePdf } from "@/lib/resumeStorage";
import { withUser } from "@/lib/auth/session";
import {
  analyzeResumeForAutomaticScoring,
  replaceResumeDerivedEvidence,
} from "@/lib/resume/autoProfile";
import { queueEntireCatalogForResume } from "@/lib/matching/resumeUploadScoring";

export const runtime = "nodejs";
export const maxDuration = 300;

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}

async function triggerHostedScoring(origin: string) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  await fetch(`${origin}/api/cron/ai-scoring/trigger`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    cache: "no-store",
  }).catch(() => undefined);
}

export const POST = withUser(async (req, user) => {
  const formData = await req.formData().catch(() => null);
  const file = formData?.get("file");
  const kindRaw = formData?.get("kind");
  const kind = kindRaw === "coverLetter" ? "coverLetter" : "resume";

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file was uploaded." }, { status: 400 });
  }

  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json(
      { error: "Only PDF files are accepted. Please upload a .pdf file." },
      { status: 400 },
    );
  }

  if (file.size > MAX_PDF_SIZE_BYTES) {
    return NextResponse.json(
      {
        error: `This PDF is ${(file.size / (1024 * 1024)).toFixed(1)} MB, which is over the 10 MB limit. Please upload a smaller file.`,
      },
      { status: 400 },
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    console.error("[resume-upload] request body could not be read", {
      errorCode: safeErrorCode(error),
    });
    return NextResponse.json(
      { error: "The uploaded PDF could not be read. Please try the upload again." },
      { status: 400 },
    );
  }

  if (!hasPdfMagicBytes(bytes)) {
    return NextResponse.json(
      { error: "This file doesn't look like a valid PDF. Please upload a real PDF file." },
      { status: 400 },
    );
  }

  let extraction;
  try {
    extraction = await extractPdfText(bytes.slice());
  } catch (error) {
    if (error instanceof PdfExtractionError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    console.error("[resume-upload] PDF extraction failed", {
      errorCode: safeErrorCode(error),
    });
    return NextResponse.json(
      { error: "The resume parser could not open this PDF. Please export it again as a standard text-based PDF." },
      { status: 500 },
    );
  }

  const status = extraction.scanned ? "scanned" : "ok";

  // The original PDF is useful for later application/document workflows, but
  // durable Blob storage is not a prerequisite for ATS matching. A resume can
  // still become the active scoring profile from its extracted text when Blob
  // storage is temporarily unavailable or not configured for this deployment.
  let doc: Awaited<ReturnType<typeof prisma.resumeDocument.create>> | null = null;
  let storageWarning: string | null = null;

  try {
    doc = await prisma.resumeDocument.create({
      data: {
        userId: user.id,
        kind,
        filename: file.name,
        sizeBytes: file.size,
        pageCount: extraction.pageCount,
        storagePath: "",
        extractedText: extraction.text,
        status,
      },
    });
  } catch (error) {
    console.error("[resume-upload] database row creation failed", {
      errorCode: safeErrorCode(error),
    });
    return NextResponse.json(
      { error: "Internship Pilot could not save the resume record. Please try again." },
      { status: 503 },
    );
  }

  try {
    const storagePath = await saveResumePdf(user.id, doc.id, bytes);
    doc = await prisma.resumeDocument.update({
      where: { id: doc.id },
      data: { storagePath },
    });
  } catch (error) {
    console.warn("[resume-upload] durable PDF storage unavailable", {
      kind,
      errorCode: safeErrorCode(error),
    });

    await prisma.resumeDocument.delete({ where: { id: doc.id } }).catch(() => undefined);
    doc = null;
    storageWarning = "The resume was processed for ATS matching, but the original PDF was not stored on this deployment.";

    if (kind === "coverLetter") {
      return NextResponse.json(
        { error: "Cover-letter storage is not configured for this deployment yet." },
        { status: 503 },
      );
    }
  }

  let automaticProfile:
    | { status: "ready"; factCount: number }
    | { status: "failed"; error: string }
    | { status: "not_applicable" }
    | { status: "scanned" } = { status: "not_applicable" };

  if (kind === "resume" && status === "scanned") {
    automaticProfile = { status: "scanned" };
  } else if (kind === "resume") {
    try {
      const facts = await analyzeResumeForAutomaticScoring(extraction.text);
      const profile = await replaceResumeDerivedEvidence(user.id, facts);
      automaticProfile = { status: "ready", factCount: profile.factCount };

      const origin = new URL(req.url).origin;
      after(async () => {
        try {
          const scheduled = await queueEntireCatalogForResume(user.id);
          console.info(JSON.stringify({
            event: "resume-first-ats-scoring",
            stage: "queued",
            userId: user.id,
            ...scheduled,
          }));
          await triggerHostedScoring(origin);
        } catch (error) {
          console.error("[resume-first-ats-scoring] automatic queue failed", {
            userId: user.id,
            errorCode:
              error && typeof error === "object" && "code" in error
                ? String((error as { code: unknown }).code)
                : "AUTOMATIC_SCORE_QUEUE_FAILED",
          });
        }
      });
    } catch (error) {
      automaticProfile = {
        status: "failed",
        error: error instanceof Error
          ? error.message
          : "Automatic resume analysis failed.",
      };
    }
  }

  return NextResponse.json(
    {
      document: {
        id: doc?.id ?? null,
        kind,
        filename: file.name,
        sizeBytes: file.size,
        pageCount: extraction.pageCount,
        status,
        persisted: Boolean(doc),
      },
      automaticProfile,
      warning: storageWarning,
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
});
