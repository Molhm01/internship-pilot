import { prisma } from "@/lib/db";
import { ollamaGenerateJSON, OllamaError } from "@/lib/ollama";
import { buildMatchPrompt } from "@/lib/prompts";
import { enforceGrounding, matchResponseSchema } from "@/lib/validation";
import { logAudit } from "@/lib/applications/audit";
import { hasUsableJobDescription, matchJobDescriptionText } from "@/lib/matchWorkflow";

export class MatchError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

// Shared by the manual "Run AI Match" button (api/match/route.ts) and the
// automatic background scoring that runs after a discovered job is verified.
export async function runMatchForJob(jobId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new MatchError("Job not found", 404);

  if (!hasUsableJobDescription(job)) {
    throw new MatchError(
      "This job does not have a usable job description yet. Add or refresh the description before running AI Match.",
      400,
    );
  }

  const facts = await prisma.resumeFact.findMany({
    where: { status: { in: ["approved", "edited"] } },
    orderBy: { createdAt: "asc" },
  });

  if (facts.length === 0) {
    throw new MatchError(
      "No approved resume facts yet. Go to Profile, analyze your resume, and approve facts first.",
      400,
    );
  }

  const prompt = buildMatchPrompt(facts, {
    ...job,
    description: matchJobDescriptionText(job),
  });

  let raw: unknown;
  try {
    raw = await ollamaGenerateJSON(prompt, { timeoutMs: 180_000 });
  } catch (err) {
    if (err instanceof OllamaError) throw new MatchError(err.message, 503);
    throw err;
  }

  const parsed = matchResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MatchError(
      "The AI model returned a match result in an unexpected format. Try again.",
      502,
    );
  }

  const validFactIds = new Set(facts.map((f) => f.id));
  const factTextById = new Map(facts.map((f) => [f.id, `${f.content} ${f.detail ?? ""}`]));
  const factTypeById = new Map(facts.map((f) => [f.id, f.type]));
  const grounded = enforceGrounding(parsed.data, validFactIds, factTextById, factTypeById);

  const factsUsed = Array.from(
    new Set([...grounded.skillsSupported, ...grounded.skillsNeedConfirmation].flatMap((s) => s.factIds)),
  );

  // Reruns are intentionally append-only versions. The job detail API sorts
  // MatchResult rows newest-first, while these denormalized Job fields expose
  // the current score to list/card queries.
  const [matchResult] = await prisma.$transaction([
    prisma.matchResult.create({
      data: {
        jobId,
        eligibility: grounded.eligibility,
        eligibilityReason: grounded.eligibilityReason,
        score: Math.round(grounded.matchScore),
        explanation: grounded.explanation,
        recommendation: grounded.recommendation,
        skillsSupported: JSON.stringify(grounded.skillsSupported),
        skillsNeedConfirmation: JSON.stringify(grounded.skillsNeedConfirmation),
        skillsToLearn: JSON.stringify(grounded.skillsToLearn),
        skillsNeverAdd: JSON.stringify(grounded.skillsNeverAdd),
        tailoringPreview: JSON.stringify(grounded.tailoringPreview),
        factsUsed: JSON.stringify(factsUsed),
      },
    }),
    prisma.job.update({
      where: { id: jobId },
      data: {
        matchScore: Math.round(grounded.matchScore),
        eligibilityStatus: grounded.eligibility,
      },
    }),
  ]);

  try {
    await logAudit({
      jobId,
      actor: "ai-match",
      action: "eligibility-scored",
      detail: `Eligibility: ${grounded.eligibility} (score ${Math.round(grounded.matchScore)}/100). ${grounded.eligibilityReason}`,
      metadata: { score: Math.round(grounded.matchScore), eligibility: grounded.eligibility, recommendation: grounded.recommendation },
    });
  } catch (error) {
    console.error("[ai-match] result persisted but audit logging failed", {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return matchResult;
}
