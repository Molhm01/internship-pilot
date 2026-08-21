import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { extractPdfText, hasPdfMagicBytes, MAX_PDF_SIZE_BYTES, PdfExtractionError } from "@/lib/pdf";
import { saveResumePdf } from "@/lib/resumeStorage";
import { withUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const maxDuration = 300;

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return error instanceof Error ? error.name : "UNKNOWN_ERROR";
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
  let doc: Awaited<ReturnType<typeof prisma.resumeDocument.create>>;
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

    if (kind === "coverLetter") {
      await prisma.resumeDocument.delete({ where: { id: doc.id } }).catch(() => undefined);
      return NextResponse.json(
        { error: "Cover-letter storage is not configured for this deployment yet." },
        { status: 503 },
      );
    }

    // Resume matching only needs the extracted text. Keep that database row so
    // local AI analysis can continue even when durable PDF storage is absent.
    storageWarning = "The resume text was saved for ATS matching, but the original PDF file could not be stored.";
  }

  const automaticProfile = kind !== "resume"
    ? { status: "not_applicable" as const }
    : status === "scanned"
      ? { status: "scanned" as const }
      : { status: "processing" as const };

  return NextResponse.json(
    {
      document: {
        id: doc.id,
        kind,
        filename: file.name,
        sizeBytes: file.size,
        pageCount: extraction.pageCount,
        status,
        persisted: Boolean(doc.storagePath),
      },
      automaticProfile,
      warning: storageWarning,
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
});
