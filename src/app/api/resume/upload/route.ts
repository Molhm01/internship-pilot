import { after, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { extractPdfText, hasPdfMagicBytes, MAX_PDF_SIZE_BYTES, PdfExtractionError } from "@/lib/pdf";
import { saveResumePdf } from "@/lib/resumeStorage";
import { withUser } from "@/lib/auth/session";
import {
  analyzeResumeForAutomaticScoring,
  replaceResumeDerivedEvidence,
} from "@/lib/resume/autoProfile";
import { scheduleAutomaticScoresForUser } from "@/lib/matching/automaticScoring";

export const runtime = "nodejs";
export const maxDuration = 300;

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

  const bytes = new Uint8Array(await file.arrayBuffer());

  if (!hasPdfMagicBytes(bytes)) {
    return NextResponse.json(
      { error: "This file doesn't look like a valid PDF. Please upload a real PDF file." },
      { status: 400 },
    );
  }

  let extraction;
  try {
    // pdf.js takes ownership of (transfers/detaches) the buffer it's given,
    // so extraction runs on a copy — `bytes` itself still needs to be
    // written to disk unchanged afterward.
    extraction = await extractPdfText(bytes.slice());
  } catch (err) {
    if (err instanceof PdfExtractionError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }

  const status = extraction.scanned ? "scanned" : "ok";

  const created = await prisma.resumeDocument.create({
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
  const doc = await prisma.resumeDocument.update({
    where: { id: created.id },
    data: { storagePath },
  });

  let automaticProfile:
    | { status: "ready"; factCount: number }
    | { status: "failed"; error: string }
    | { status: "not_applicable" }
    | { status: "scanned" } = { status: "not_applicable" };

  if (kind === "resume" && doc.status === "scanned") {
    automaticProfile = { status: "scanned" };
  } else if (kind === "resume") {
    try {
      const facts = await analyzeResumeForAutomaticScoring(doc.extractedText);
      const profile = await replaceResumeDerivedEvidence(user.id, facts);
      automaticProfile = { status: "ready", factCount: profile.factCount };

      const origin = new URL(req.url).origin;
      // Queue every active job after the response is safe to send. The first
      // scoring worker is then kicked immediately; the live 5-minute engine
      // keeps draining the same durable queue afterwards.
      after(async () => {
        try {
          const scheduled = await scheduleAutomaticScoresForUser(user.id);
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
      // The PDF is still stored successfully. The previous scoring profile is
      // left active until this resume can be analyzed successfully; we never
      // switch the user to partially extracted evidence.
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
        id: doc.id,
        kind: doc.kind,
        filename: doc.filename,
        sizeBytes: doc.sizeBytes,
        pageCount: doc.pageCount,
        status: doc.status,
      },
      automaticProfile,
    },
    { status: 201 },
  );
});
