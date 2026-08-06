import { NextResponse } from "next/server";
import { DocumentGenerationError, generateDocumentsForJob } from "@/lib/documents/generate";
import type { AgentDeliveryOutcome } from "@/lib/documents/agentDelivery";

type GenerationResponse = {
  ok: boolean;
  error?: string;
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

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let id = "unknown";
  try {
    ({ id } = await params);
    progress(id, "request_received");
    const body = await req.json().catch(() => ({}));
    const includeCoverLetter = body?.includeCoverLetter !== false;
    const result = await generateDocumentsForJob(id, { includeCoverLetter });
    const payload: GenerationResponse = {
      ok: true,
      resumeDocumentId: result.resume.id,
      ...(result.coverLetter ? { coverLetterDocumentId: result.coverLetter.id } : {}),
      agentDelivery: {
        resume: result.agentDelivery?.resume ?? null,
        coverLetter: result.agentDelivery?.coverLetter ?? null,
      },
    };
    progress(id, "response_returned", {
      ok: true,
      resumeDelivered: result.agentDelivery?.resume.delivered ?? null,
      coverLetterDelivered: result.agentDelivery?.coverLetter?.delivered ?? null,
    });
    return NextResponse.json(payload);
  } catch (err) {
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
}
