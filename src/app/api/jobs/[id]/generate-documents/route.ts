import { NextResponse } from "next/server";
import { DocumentGenerationError, generateDocumentsForJob } from "@/lib/documents/generate";
import { prisma } from "@/lib/db";
import { buildEffectiveMatchDescription } from "@/lib/matching";
import { hasUsableJobDescription } from "@/lib/matchWorkflow";
import { ensureStarterProfile } from "@/lib/bootstrap";
import { LocalOnlyFeatureError } from "@/lib/runtime/deployment";
import type { AgentDeliveryOutcome } from "@/lib/documents/agentDelivery";
import { withUser } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

type GenerationResponse = {
  ok: boolean;
  error?: string;
  /**
   * Set when generation cannot run here at all, as opposed to having failed.
   * The page shows "Local AI offline" and an action, rather than a retry
   * button for something no number of retries will change.
   */
  localOnly?: boolean;
  resumeDocumentId?: string;
  coverLetterDocumentId?: string;
  /**
   * Whether the agent acknowledged holding each file. Generated and delivered
   * are different states, and the page has to be able to show them separately —
   * a résumé the extension cannot attach is not "sent".
   */
  agentDelivery?: {
    resume: AgentDeliveryOutcome | null;
    coverLetter: AgentDeliveryOutcome | null;
  };
};

function safeError(message: string): string {
  return message
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function progress(jobId: string, stage: string, details: Record<string, unknown> = {}) {
  console.info(JSON.stringify({ event: "tailored-document-generation", jobId, stage, ...details }));
}

/** Generates this user's tailored documents for a shared job. */
export const POST = withUser<Params>(async (req, user, { params }) => {
  let id = "unknown";
  try {
    ({ id } = await params);
    progress(id, "request_received");
    const body = await req.json().catch(() => ({}));
    const includeCoverLetter = body?.includeCoverLetter !== false;
    await ensureStarterProfile(user.id).catch(() => undefined);

    const existingJob = await prisma.job.findUnique({ where: { id } });
    if (existingJob && !hasUsableJobDescription(existingJob)) {
      await prisma.job.update({
        where: { id },
        data: { description: buildEffectiveMatchDescription(existingJob) },
      }).catch(() => undefined);
    }

    const result = await generateDocumentsForJob(id, user.id, { includeCoverLetter });
    const coverDoc = "coverLetter" in result ? result.coverLetter : undefined;
    const coverDelivery = result.agentDelivery && "coverLetter" in result.agentDelivery
      ? result.agentDelivery.coverLetter ?? null
      : null;
    const payload: GenerationResponse = {
      ok: true,
      resumeDocumentId: result.resume.id,
      ...(coverDoc ? { coverLetterDocumentId: coverDoc.id } : {}),
      agentDelivery: {
        resume: result.agentDelivery?.resume ?? null,
        coverLetter: coverDelivery,
      },
    };
    progress(id, "response_returned", {
      ok: true,
      resumeDelivered: result.agentDelivery?.resume.delivered ?? null,
      coverLetterDelivered: coverDelivery?.delivered ?? null,
    });
    return NextResponse.json(payload);
  } catch (err) {
    // Typst compiles these PDFs with a native binary on the machine running
    // Internship Pilot. A deployed server has no Typst and no writable disk, so
    // this is reported as "runs on your computer" and not as a failure.
    if (err instanceof LocalOnlyFeatureError) {
      const payload: GenerationResponse = { ok: false, localOnly: true, error: safeError(err.message) };
      progress(id, "response_returned", { ok: false, stage: "local_runtime_required" });
      return NextResponse.json(payload, { status: 501 });
    }
    if (err instanceof DocumentGenerationError) {
      const payload: GenerationResponse = { ok: false, error: safeError(err.message) };
      progress(id, "response_returned", { ok: false, stage: err.stage });
      return NextResponse.json(payload, { status: 400 });
    }
    console.error("Tailored-document generation failed unexpectedly.", { jobId: id, error: err });
    const payload: GenerationResponse = {
      ok: false,
      error: "Document generation failed unexpectedly. Existing versions were kept.",
    };
    progress(id, "response_returned", { ok: false, stage: "unexpected" });
    return NextResponse.json(payload, { status: 500 });
  }
});
