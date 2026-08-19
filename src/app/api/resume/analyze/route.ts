import { after, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { geminiGenerateJSON, GeminiError } from "@/lib/gemini";
import { ollamaGenerateJSON, OllamaError } from "@/lib/ollama";
import { buildResumeAnalysisPrompt } from "@/lib/prompts";
import {
  resumeAnalysisResponseJsonSchema,
  resumeAnalysisResponseSchema,
} from "@/lib/validation";
import { withUser } from "@/lib/auth/session";
import { scheduleAutomaticScoresForUser } from "@/lib/matching/automaticScoring";
import { isCloudRuntime } from "@/lib/runtime/deployment";

export const runtime = "nodejs";
export const maxDuration = 300;

function sanitizeResumeAnalysis(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { facts?: unknown }).facts)) {
    return raw;
  }

  return {
    facts: (raw as { facts: unknown[] }).facts.filter(
      (fact): fact is Record<string, unknown> =>
        !!fact
        && typeof fact === "object"
        && typeof (fact as Record<string, unknown>).type === "string"
        && typeof (fact as Record<string, unknown>).content === "string"
        && ((fact as Record<string, unknown>).content as string).trim().length > 0,
    ),
  };
}

function queueAutomaticScoring(userId: string) {
  after(async () => {
    try {
      const result = await scheduleAutomaticScoresForUser(userId);
      console.info(JSON.stringify({
        event: "resume-profile-auto-score",
        userId,
        ...result,
      }));
    } catch (error) {
      console.error("[resume-analyze] automatic score scheduling failed", {
        userId,
        errorCode:
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "AUTOMATIC_SCORE_QUEUE_FAILED",
      });
    }
  });
}

/**
 * A resume submission is the candidate profile for matching.
 *
 * The model only extracts literal resume facts. Successful extraction replaces
 * the previous AI-derived resume facts, preserves explicitly manual facts,
 * clears the denormalized current job scores so an old resume is never shown as
 * current, and queues every active internship for automatic scoring.
 */
export const POST = withUser(async (req, user) => {
  const body = await req.json().catch(() => null);
  const resumeText = typeof body?.resumeText === "string" ? body.resumeText.trim() : "";

  if (!resumeText) {
    return NextResponse.json({ error: "resumeText is required" }, { status: 400 });
  }
  if (resumeText.length < 30) {
    return NextResponse.json(
      { error: "Resume text looks too short to analyze. Upload your full resume." },
      { status: 400 },
    );
  }

  const prompt = buildResumeAnalysisPrompt(resumeText);

  let raw: unknown;
  try {
    raw = isCloudRuntime()
      ? await geminiGenerateJSON(prompt, {
          schema: resumeAnalysisResponseJsonSchema,
          timeoutMs: 60_000,
        })
      : await ollamaGenerateJSON(prompt, { timeoutMs: 180_000 });
  } catch (error) {
    if (error instanceof GeminiError) {
      return NextResponse.json(
        {
          error:
            error.code === "GEMINI_API_KEY_MISSING"
              ? "Resume analysis is not configured for this deployment yet."
              : "The cloud resume analyzer is temporarily unavailable.",
          code: error.code,
        },
        { status: error.status },
      );
    }
    if (error instanceof OllamaError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 503 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error analyzing resume." },
      { status: 500 },
    );
  }

  const parsed = resumeAnalysisResponseSchema.safeParse(sanitizeResumeAnalysis(raw));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "The AI model returned resume facts in an unexpected format. Try the upload again.",
        details: parsed.error.flatten(),
      },
      { status: 502 },
    );
  }

  const seen = new Set<string>();
  const facts = parsed.data.facts.filter((fact) => {
    const key = `${fact.type}::${fact.content.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // An empty extraction is not allowed to erase a previously useful profile.
  if (facts.length === 0) {
    return NextResponse.json(
      { error: "No usable facts could be extracted from this resume. Your existing profile was not changed." },
      { status: 422 },
    );
  }

  await prisma.$transaction([
    // The newest submitted resume is the source of truth for AI-extracted facts.
    // Explicitly manual facts survive because the user supplied those directly.
    prisma.resumeFact.deleteMany({
      where: { userId: user.id, source: { not: "manual" } },
    }),
    // Never display a score calculated from the previous resume while the new
    // profile is waiting in the scoring queue. MatchResult history remains.
    prisma.userJobState.updateMany({
      where: { userId: user.id },
      data: { matchScore: null, eligibilityStatus: null, matchedAt: null },
    }),
    ...facts.map((fact) =>
      prisma.resumeFact.create({
        data: {
          userId: user.id,
          type: fact.type,
          content: fact.content.trim(),
          detail: fact.detail?.trim() || null,
          status: "approved",
          source: "ai",
        },
      }),
    ),
  ]);

  queueAutomaticScoring(user.id);

  return NextResponse.json(
    {
      facts,
      profileUpdated: true,
      scoring: "queued",
      message: `Resume profile updated with ${facts.length} facts. Internship matches will refresh automatically.`,
    },
    { headers: { "cache-control": "no-store" } },
  );
});
