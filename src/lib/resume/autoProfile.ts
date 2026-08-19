import { prisma } from "@/lib/db";
import { geminiGenerateJSON } from "@/lib/gemini";
import { ollamaGenerateJSON } from "@/lib/ollama";
import { buildResumeAnalysisPrompt } from "@/lib/prompts";
import { isCloudRuntime } from "@/lib/runtime/deployment";
import {
  resumeAnalysisResponseSchema,
  type CandidateFact,
} from "@/lib/validation";

const resumeAnalysisJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "content", "detail"],
        properties: {
          type: {
            type: "string",
            enum: [
              "education",
              "gpa",
              "graduationDate",
              "coursework",
              "skill",
              "project",
              "experience",
              "activity",
            ],
          },
          content: { type: "string" },
          detail: { type: ["string", "null"] },
        },
      },
    },
  },
};

function sanitizeResumeAnalysis(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { facts?: unknown }).facts)) {
    return raw;
  }
  return {
    facts: (raw as { facts: unknown[] }).facts
      .filter(
        (fact): fact is Record<string, unknown> =>
          Boolean(fact)
          && typeof fact === "object"
          && typeof (fact as Record<string, unknown>).type === "string"
          && typeof (fact as Record<string, unknown>).content === "string"
          && ((fact as Record<string, unknown>).content as string).trim().length > 0,
      )
      .map((fact) => ({
        type: fact.type,
        content: fact.content,
        detail: typeof fact.detail === "string" && fact.detail.trim() ? fact.detail : null,
      })),
  };
}

/**
 * Extract literal, scoreable evidence from one uploaded resume.
 *
 * This is intentionally the same strict evidence contract used by the old
 * review-first flow, but it can now run automatically after upload. The model
 * is never allowed to infer or embellish candidate qualifications.
 */
export async function analyzeResumeForAutomaticScoring(resumeText: string): Promise<CandidateFact[]> {
  const text = resumeText.trim();
  if (text.length < 30) throw new Error("Resume text is too short to analyze.");

  const prompt = buildResumeAnalysisPrompt(text);
  const raw = isCloudRuntime()
    ? await geminiGenerateJSON(prompt, {
        schema: resumeAnalysisJsonSchema,
        timeoutMs: 60_000,
        model: process.env.GEMINI_RESUME_MODEL?.trim() || undefined,
      })
    : await ollamaGenerateJSON(prompt, {
        timeoutMs: 180_000,
        temperature: 0,
        format: resumeAnalysisJsonSchema,
      });

  const parsed = resumeAnalysisResponseSchema.safeParse(sanitizeResumeAnalysis(raw));
  if (!parsed.success) {
    throw new Error("The AI model returned resume evidence in an unexpected format.");
  }

  const seen = new Set<string>();
  return parsed.data.facts.filter((fact) => {
    const key = `${fact.type}::${fact.content.trim().toLowerCase()}::${fact.detail?.trim().toLowerCase() ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Make a newly uploaded resume the user's current scoring evidence.
 * Manual facts are preserved; everything derived from an older resume is
 * replaced. Existing displayed scores are cleared immediately so the UI never
 * shows a score from the previous PDF while the new queue is being processed.
 */
export async function replaceResumeDerivedEvidence(
  userId: string,
  facts: CandidateFact[],
): Promise<{ factCount: number }> {
  if (facts.length === 0) {
    throw new Error("No scoreable facts were found in this resume.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.resumeFact.deleteMany({
      where: {
        userId,
        NOT: { source: "manual" },
      },
    });

    // Bullets generated from older fact ids are no longer safe to reuse after
    // a resume replacement. They can be rebuilt later from the new evidence.
    await tx.resumeBullet.deleteMany({ where: { userId } });

    await tx.resumeFact.createMany({
      data: facts.map((fact) => ({
        userId,
        type: fact.type,
        content: fact.content.trim(),
        detail: fact.detail?.trim() || null,
        status: "approved",
        source: "resume-auto",
      })),
    });

    await tx.userJobState.updateMany({
      where: { userId },
      data: {
        matchScore: null,
        eligibilityStatus: null,
        matchedAt: null,
      },
    });
  });

  return { factCount: facts.length };
}
