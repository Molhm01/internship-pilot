import { guardSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { analyzeResumeForAutomaticScoring } from "@/lib/resume/autoProfile";

/**
 * Compatibility endpoint for explicit re-analysis/debugging. Normal users no
 * longer need to call this manually: /api/resume/upload analyzes the PDF and
 * starts ATS scoring automatically.
 */
export async function POST(req: Request) {
  const denied = await guardSession();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  const resumeText = typeof body?.resumeText === "string" ? body.resumeText.trim() : "";

  if (!resumeText) {
    return NextResponse.json({ error: "resumeText is required" }, { status: 400 });
  }
  if (resumeText.length < 30) {
    return NextResponse.json(
      { error: "Resume text looks too short to analyze. Paste your full resume." },
      { status: 400 },
    );
  }

  try {
    const facts = await analyzeResumeForAutomaticScoring(resumeText);
    return NextResponse.json({ facts });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error analyzing resume." },
      { status: 503 },
    );
  }
}
