import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { extractPdfText, hasPdfMagicBytes, MAX_PDF_SIZE_BYTES, PdfExtractionError } from "@/lib/pdf";
import { saveResumePdf } from "@/lib/resumeStorage";
import { withUser } from "@/lib/auth/session";

function storageErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String((error as { code: unknown }).code);
  return error instanceof Error ? error.name : "STORAGE_WRITE_FAILED";
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

  const bytes = new Uint8Array(await file.arrayBuffer());

  if (!hasPdfMagicBytes(bytes)) {
    return NextResponse.json(
      { error: "This file doesn't look like a valid PDF. Please upload a real PDF file." },
      { status: 400 },
    );
  }

  let extraction;
  try {
    extraction = await extractPdfText(bytes.slice());
  } catch (err) {
    if (err instanceof PdfExtractionError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error("[resume-upload] PDF extraction failed", { errorCode: storageErrorCode(err) });
    return NextResponse.json(
      { error: "The resume PDF could not be read. Try exporting it as a standard text-based PDF and upload it again." },
      { status: 500 },
    );
  }

  const status = extraction.scanned ? "scanned" : "ok";

  // Persisting the original PDF is useful for document/application workflows,
  // but it must never block ATS matching. If production Blob storage is not
  // configured yet, a resume can still be parsed and scored from the extracted
  // text returned by this request. Cover letters still require durable storage.
  let created: Awaited<ReturnType<typeof prisma.resumeDocument.create>> | null = null;
  try {
    created = await prisma.resumeDocument.create({
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

    const storagePath = await saveResumePdf(user.id, created.id, bytes);
    created = await prisma.resumeDocument.update({
      where: { id: created.id },
      data: { storagePath },
    });
  } catch (error) {
    console.warn("[resume-upload] durable PDF storage unavailable", {
      kind,
      errorCode: storageErrorCode(error),
    });

    if (created) {
      await prisma.resumeDocument.delete({ where: { id: created.id } }).catch(() => {});
    }

    if (kind === "coverLetter") {
      return NextResponse.json(
        { error: "Cover-letter storage is not configured for this deployment yet." },
        { status: 503 },
      );
    }

    return NextResponse.json(
      {
        document: {
          id: "",
          kind,
          filename: file.name,
          sizeBytes: file.size,
          pageCount: extraction.pageCount,
          status,
          extractedText: status === "scanned" ? "" : extraction.text,
          persisted: false,
        },
        warning: "Your resume can still be analyzed and matched, but the original PDF was not stored on this deployment.",
      },
      { status: 201 },
    );
  }

  return NextResponse.json(
    {
      document: {
        id: created.id,
        kind: created.kind,
        filename: created.filename,
        sizeBytes: created.sizeBytes,
        pageCount: created.pageCount,
        status: created.status,
        extractedText: created.status === "scanned" ? "" : created.extractedText,
        persisted: true,
      },
    },
    { status: 201 },
  );
});
