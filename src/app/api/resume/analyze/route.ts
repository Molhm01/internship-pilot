import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withUser } from "@/lib/auth/session";
import {
  analyzeResumeForAutomaticScoring,
  replaceResumeDerivedEvidence,
} from "@/lib/resume/autoProfile";
import { queueEntireCatalogForResume } from "@/lib/matching/resumeUploadScoring";
import { triggerInitialAiMatchWorker } from "@/lib/matching/initialAiMatchQueue";

/**
 * Analyze an already-uploaded resume document and activate its evidence for ATS
 * scoring. Keeping this separate from the PDF upload means the browser can show
 * a saved-document state immediately instead of looking frozen for the entire
 * local-model inference window.
 *
 * `resumeText` remains accepted for compatibility with older debugging tools.
 */
export const POST = withUser(async (req, user) => {
  const body = await req.json().catch(() => null);
  const documentId = typeof body?.documentId === "string" ? body.documentId.trim() : "";
  let resumeText = typeof body?.resumeText === "string" ? body.resumeText.trim() : "";

  if (documentId) {
    const document = await prisma.resumeDocument.findFirst({
      where: { id: documentId, userId: user.id, kind: "resume" },
      select: { extractedText: true, status: true },
    });
    if (!document) {
      return NextResponse.json({ error: "Resume document was not found." }, { status: 404 });
    }
    if (document.status === "scanned") {
      return NextResponse.json(
        { error: "This PDF appears to be scanned and has no usable text to analyze." },
        { status: 422 },
      );
    }
    resumeText = document.extractedText.trim();
  }

  if (!resumeText) {
    return NextResponse.json({ error: "documentId or resumeText is required" }, { status: 400 });
  }
  if (resumeText.length < 30) {
    return NextResponse.json(
      { error: "Resume text looks too short to analyze." },
      { status: 400 },
    );
  }

  try {
    const facts = await analyzeResumeForAutomaticScoring(resumeText);
    const profile = await replaceResumeDerivedEvidence(user.id, facts);
    const scheduled = await queueEntireCatalogForResume(user.id);
    triggerInitialAiMatchWorker();

    console.info(JSON.stringify({
      event: "resume-first-ats-scoring",
      stage: "queued",
      userId: user.id,
      ...scheduled,
    }));

    return NextResponse.json({
      status: "ready",
      factCount: profile.factCount,
      queuedJobs: scheduled.queuedRows,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error analyzing resume." },
      { status: 503 },
    );
  }
});
