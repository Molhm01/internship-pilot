import { prisma } from "@/lib/db";
import { geminiGenerateJSON, hasGeminiApiKey } from "@/lib/gemini";
import { checkOllamaHealth, ollamaGenerateJSON } from "@/lib/ollama";
import { buildResumeAnalysisPrompt } from "@/lib/prompts";
import {
  extractLiteralFactsFromResumeText,
  extractProfileFieldsFromResumeText,
} from "@/lib/resume/deterministicParser";
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
 * Cascade:
 *   1. Gemini (when GEMINI_API_KEY is configured)
 *   2. Local Ollama (when local runtime and Ollama daemon is reachable)
 *   3. Deterministic literal PDF resume-text extractor (always available offline/cloud)
 *
 * None of these layers is allowed to infer or fabricate candidate qualifications.
 */
export async function analyzeResumeForAutomaticScoring(resumeText: string): Promise<CandidateFact[]> {
  const text = resumeText.trim();
  if (text.length < 30) throw new Error("Resume text is too short to analyze.");

  const prompt = buildResumeAnalysisPrompt(text);
  let raw: unknown = null;

  if (hasGeminiApiKey()) {
    try {
      raw = await geminiGenerateJSON(prompt, {
        schema: resumeAnalysisJsonSchema,
        timeoutMs: 60_000,
        model: process.env.GEMINI_RESUME_MODEL?.trim() || undefined,
      });
    } catch (error) {
      console.warn("[resume-analyze] Gemini extraction failed, falling back cleanly", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!raw) {
    const ollama = await checkOllamaHealth().catch(() => ({ reachable: false, modelInstalled: false, models: [] }));
    if (ollama.reachable && ollama.modelInstalled) {
      try {
        raw = await ollamaGenerateJSON(prompt, {
          timeoutMs: 90_000,
          temperature: 0,
          format: resumeAnalysisJsonSchema,
        });
      } catch (error) {
        console.warn("[resume-analyze] Ollama extraction failed, falling back cleanly", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  let candidateFacts: CandidateFact[] | null = null;
  if (raw) {
    const parsed = resumeAnalysisResponseSchema.safeParse(sanitizeResumeAnalysis(raw));
    if (parsed.success && parsed.data.facts.length > 0) {
      candidateFacts = parsed.data.facts;
    }
  }

  if (!candidateFacts) {
    candidateFacts = extractLiteralFactsFromResumeText(text);
  }

  if (!candidateFacts || candidateFacts.length === 0) {
    throw new Error("Could not extract any readable resume facts from this PDF.");
  }

  const seen = new Set<string>();
  return candidateFacts.filter((fact) => {
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
  resumeText?: string,
): Promise<{ factCount: number }> {
  if (facts.length === 0) {
    throw new Error("No scoreable facts were found in this resume.");
  }

  const extractedProfile = resumeText ? extractProfileFieldsFromResumeText(resumeText) : {};

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

    // Populate any missing or placeholder profile fields directly from literal resume content
    const existingProfile = await tx.userProfile.findUnique({ where: { userId } });
    if (existingProfile) {
      const updates: Record<string, string> = {};
      const isPlaceholderEmail = !existingProfile.applicationEmail?.trim()
        || /@(?:njit-pilot\.edu|example\.(?:com|edu)|internshippilot\.local)$/i.test(existingProfile.applicationEmail);
      const isPlaceholderPhone = !existingProfile.phone?.trim()
        || existingProfile.phone.trim() === "(973) 555-0194";
      const isPlaceholderLinkedin = !existingProfile.linkedinUrl?.trim()
        || /linkedin\.com\/in\/(?:alex|mj|candidate)-eng\/?$/i.test(existingProfile.linkedinUrl);
      const isPlaceholderGithub = !existingProfile.githubUrl?.trim()
        || /github\.com\/(?:alex|mj|candidate)-dev\/?$/i.test(existingProfile.githubUrl);

      if (!existingProfile.preferredName?.trim() && extractedProfile.fullName) {
        updates.preferredName = extractedProfile.fullName;
      }
      if (!existingProfile.legalFirstName?.trim() && extractedProfile.fullName) {
        const parts = extractedProfile.fullName.trim().split(/\s+/);
        if (parts.length >= 2) {
          updates.legalFirstName = parts[0];
          if (!existingProfile.legalLastName?.trim()) {
            updates.legalLastName = parts.slice(1).join(" ");
          }
        }
      }
      if (isPlaceholderEmail && extractedProfile.email) {
        updates.applicationEmail = extractedProfile.email;
      }
      if (isPlaceholderPhone && extractedProfile.phone) updates.phone = extractedProfile.phone;
      if (isPlaceholderLinkedin && extractedProfile.linkedin) updates.linkedinUrl = extractedProfile.linkedin;
      if (isPlaceholderGithub && extractedProfile.github) updates.githubUrl = extractedProfile.github;
      if (!existingProfile.portfolioUrl?.trim() && extractedProfile.website) {
        updates.portfolioUrl = extractedProfile.website;
      }
      if (Object.keys(updates).length > 0) {
        await tx.userProfile.update({
          where: { userId },
          data: updates,
        });
      }
    }

    if (extractedProfile.school || extractedProfile.major || extractedProfile.gpa || extractedProfile.graduationDate) {
      const existingEdu = await tx.education.findFirst({ where: { userId }, orderBy: { sortOrder: "asc" } });
      const gradParts = (extractedProfile.graduationDate ?? "").match(/^(\d{4})(?:-(\d{2}))?$/);
      const gradYear = gradParts?.[1] ?? undefined;
      const gradMonth = gradParts?.[2] ?? undefined;
      if (existingEdu) {
        const eduUpdates: Record<string, string> = {};
        if (!existingEdu.school?.trim() && extractedProfile.school) eduUpdates.school = extractedProfile.school;
        if (!existingEdu.major?.trim() && extractedProfile.major) eduUpdates.major = extractedProfile.major;
        if (!existingEdu.gpa?.trim() && extractedProfile.gpa) eduUpdates.gpa = extractedProfile.gpa;
        if (!existingEdu.graduationYear?.trim() && gradYear) eduUpdates.graduationYear = gradYear;
        if (!existingEdu.graduationMonth?.trim() && gradMonth) eduUpdates.graduationMonth = gradMonth;
        if (Object.keys(eduUpdates).length > 0) {
          await tx.education.update({ where: { id: existingEdu.id }, data: eduUpdates });
        }
      } else if (extractedProfile.school) {
        await tx.education.create({
          data: {
            userId,
            school: extractedProfile.school,
            major: extractedProfile.major ?? null,
            gpa: extractedProfile.gpa ?? null,
            graduationYear: gradYear ?? null,
            graduationMonth: gradMonth ?? null,
          },
        });
      }
    }
  });

  return { factCount: facts.length };
}
