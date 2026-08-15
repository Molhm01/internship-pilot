import { prisma } from "@/lib/db";
import { ollamaGenerateJSON, OllamaError, type OllamaTiming } from "@/lib/ollama";
import { buildCompactMatchPrompt } from "@/lib/prompts";
import {
  enforceGrounding,
  matchResponseJsonSchema,
  matchResponseSchema,
  type MatchResponse,
} from "@/lib/validation";
import { logAudit } from "@/lib/applications/audit";
import { hasUsableJobDescription, matchJobDescriptionText } from "@/lib/matchWorkflow";
import {
  normalizeMatchDescription,
  selectRelevantApprovedFacts,
} from "@/lib/matching/input";

export class MatchError extends Error {
  constructor(
    message: string,
    public readonly status = 500,
    public readonly code = "MATCH_FAILED",
  ) {
    super(message);
    this.name = "MatchError";
  }
}

function configuredInteger(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export const MATCH_MODEL_TIMEOUT_MS = configuredInteger(
  "AI_MATCH_MODEL_TIMEOUT_MS",
  180_000,
  30_000,
  300_000,
);
export const MATCH_MODEL_NUM_PREDICT = configuredInteger("AI_MATCH_NUM_PREDICT", 1_200, 400, 2_400);
export const MATCH_MODEL_CONTEXT_TOKENS = configuredInteger("AI_MATCH_CONTEXT_TOKENS", 8_192, 4_096, 16_384);
export const MATCH_MALFORMED_RETRIES = configuredInteger("AI_MATCH_MALFORMED_RETRIES", 1, 0, 2);
export const MATCH_MODEL_KEEP_ALIVE = process.env.AI_MATCH_KEEP_ALIVE?.trim() || "10m";

function progress(jobId: string, stage: string) {
  console.info(JSON.stringify({ event: "ai-match", jobId, stage }));
}

function timing(jobId: string, stage: string, durationMs: number, details: Record<string, number> = {}) {
  if (process.env.NODE_ENV !== "development") return;
  console.info(JSON.stringify({
    event: "ai-match-timing",
    jobId,
    stage,
    durationMs: Math.max(0, Math.round(durationMs)),
    ...details,
  }));
}

// Shared by the manual "Run AI Match" button (api/match/route.ts) and the
// automatic background scoring that runs after a discovered job is verified.
export type MatchOrigin = "MANUAL" | "INITIAL_AUTO";

/**
 * Scores one job for one person.
 *
 * `userId` is required and is not optional-with-a-default on purpose. A match
 * is a statement about a particular applicant — it reads their approved résumé
 * facts and it produces a number that belongs to them — and the version of this
 * function that took only a job id could not have been written correctly in a
 * multi-user system: it read whichever facts were in the table and wrote the
 * result onto the shared Job row, so the last person to score a job set
 * everybody's score.
 */
export async function runMatchForJob(
  jobId: string,
  options: { userId: string; origin?: MatchOrigin },
) {
  const { userId } = options;
  const totalStartedAt = performance.now();
  const jobReadStartedAt = performance.now();
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      internshipTerm: true,
      duration: true,
      description: true,
      jobResponsibilities: true,
      jobQualifications: true,
    },
  });
  timing(jobId, "database_job_read", performance.now() - jobReadStartedAt);
  if (!job) throw new MatchError("The selected job could not be found.", 404, "JOB_NOT_FOUND");
  progress(jobId, "job_loaded");

  if (!hasUsableJobDescription(job)) {
    throw new MatchError(
      "This job does not have a usable job description yet. Add or refresh the description before running AI Match.",
      400,
      "JOB_DESCRIPTION_INSUFFICIENT",
    );
  }

  const profileReadStartedAt = performance.now();
  const approvedFacts = await prisma.resumeFact.findMany({
    where: { userId, status: { in: ["approved", "edited"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, type: true, content: true, detail: true },
  });
  timing(jobId, "database_profile_read", performance.now() - profileReadStartedAt, {
    approvedFactCount: approvedFacts.length,
  });
  progress(jobId, "profile_loaded");

  if (approvedFacts.length === 0) {
    throw new MatchError(
      "No approved resume facts yet. Go to Profile, analyze your resume, and approve facts first.",
      400,
      "PROFILE_FACTS_MISSING",
    );
  }

  const promptStartedAt = performance.now();
  const description = normalizeMatchDescription(matchJobDescriptionText(job));
  const facts = selectRelevantApprovedFacts(approvedFacts, `${job.title}\n${description}`);
  const prompt = buildCompactMatchPrompt(facts, {
    ...job,
    description,
  });
  timing(jobId, "prompt_construction", performance.now() - promptStartedAt, {
    descriptionChars: description.length,
    approvedFactCount: approvedFacts.length,
    selectedFactCount: facts.length,
    promptChars: prompt.length,
  });

  let validated: MatchResponse | null = null;
  let malformedRetries = 0;
  for (let attempt = 0; attempt <= MATCH_MALFORMED_RETRIES; attempt += 1) {
    let raw: unknown;
    const modelTiming: Partial<OllamaTiming> = {};
    const modelStartedAt = performance.now();
    try {
      progress(jobId, "model_request_started");
      raw = await ollamaGenerateJSON(prompt, {
        timeoutMs: MATCH_MODEL_TIMEOUT_MS,
        temperature: 0,
        format: matchResponseJsonSchema,
        keepAlive: MATCH_MODEL_KEEP_ALIVE,
        numPredict: MATCH_MODEL_NUM_PREDICT,
        numCtx: MATCH_MODEL_CONTEXT_TOKENS,
        onTiming: (value) => { Object.assign(modelTiming, value); },
      });
      progress(jobId, "model_response_received");
    } catch (err) {
      if (err instanceof OllamaError && err.code === "MODEL_OUTPUT_INVALID_JSON" && attempt < MATCH_MALFORMED_RETRIES) {
        malformedRetries += 1;
        continue;
      }
      if (err instanceof OllamaError) {
        const timedOut = /timeout|timed out|abort/i.test(
          `${err.message} ${err.metadata?.responseBody ?? ""}`,
        );
        throw new MatchError(
          timedOut
            ? "The AI model took too long to respond. Try Run AI Match again."
            : "The local AI model is unavailable. Check Ollama, then try again.",
          timedOut ? 504 : 503,
          timedOut ? "MODEL_TIMEOUT" : "MODEL_UNAVAILABLE",
        );
      }
      throw err;
    } finally {
      timing(jobId, "ollama_request", performance.now() - modelStartedAt, {
        attempt: attempt + 1,
        connectionMs: modelTiming?.connectionMs ?? 0,
        modelLoadMs: modelTiming?.modelLoadMs ?? 0,
        promptEvaluationMs: modelTiming?.promptEvaluationMs ?? 0,
        modelGenerationMs: modelTiming?.modelGenerationMs ?? 0,
        jsonParseMs: modelTiming?.jsonParseMs ?? 0,
      });
    }

    const schemaValidationStartedAt = performance.now();
    const parsed = matchResponseSchema.safeParse(raw);
    timing(jobId, "schema_validation", performance.now() - schemaValidationStartedAt, {
      attempt: attempt + 1,
    });
    if (parsed.success) {
      validated = parsed.data;
      break;
    }
    if (attempt < MATCH_MALFORMED_RETRIES) {
      malformedRetries += 1;
      continue;
    }
  }
  if (!validated) {
    throw new MatchError(
      "The AI model returned a match result in an unexpected format. Try again.",
      502,
      "MODEL_RESPONSE_INVALID",
    );
  }
  progress(jobId, "response_validated");

  const groundingStartedAt = performance.now();
  const validFactIds = new Set(facts.map((f) => f.id));
  const factTextById = new Map(facts.map((f) => [f.id, `${f.content} ${f.detail ?? ""}`]));
  const factTypeById = new Map(facts.map((f) => [f.id, f.type]));
  const grounded = enforceGrounding(validated, validFactIds, factTextById, factTypeById);
  timing(jobId, "grounding_validation", performance.now() - groundingStartedAt, {
    malformedRetries,
  });

  const factsUsed = Array.from(
    new Set([...grounded.skillsSupported, ...grounded.skillsNeedConfirmation].flatMap((s) => s.factIds)),
  );

  // Reruns are intentionally append-only versions. The job detail API sorts
  // MatchResult rows newest-first, while these denormalized Job fields expose
  // the current score to list/card queries.
  let matchResult: Awaited<ReturnType<typeof prisma.matchResult.create>>;
  const persistenceStartedAt = performance.now();
  try {
    [matchResult] = await prisma.$transaction([
      prisma.matchResult.create({
        data: {
          userId,
          jobId,
          eligibility: grounded.eligibility,
          eligibilityReason: grounded.eligibilityReason,
          score: grounded.matchScore,
          explanation: grounded.explanation,
          recommendation: grounded.recommendation,
          skillsSupported: JSON.stringify(grounded.skillsSupported),
          skillsNeedConfirmation: JSON.stringify(grounded.skillsNeedConfirmation),
          skillsToLearn: JSON.stringify(grounded.skillsToLearn),
          skillsNeverAdd: JSON.stringify(grounded.skillsNeverAdd),
          tailoringPreview: JSON.stringify(grounded.tailoringPreview),
          factsUsed: JSON.stringify(factsUsed),
          origin: options.origin ?? "MANUAL",
        },
      }),
      // The denormalized copy lives on the per-user state row, never on the
      // shared Job. Job.matchScore/eligibilityStatus are deprecated columns
      // that nothing reads any more.
      prisma.userJobState.upsert({
        where: { userId_jobId: { userId, jobId } },
        create: {
          userId,
          jobId,
          matchScore: grounded.matchScore,
          eligibilityStatus: grounded.eligibility,
          matchedAt: new Date(),
        },
        update: {
          matchScore: grounded.matchScore,
          eligibilityStatus: grounded.eligibility,
          matchedAt: new Date(),
        },
      }),
    ]);
  } catch {
    throw new MatchError(
      "The validated AI Match result could not be saved. The previous result is still active.",
      500,
      "MATCH_PERSISTENCE_FAILED",
    );
  }
  timing(jobId, "result_persistence", performance.now() - persistenceStartedAt);
  progress(jobId, "result_persisted");

  try {
    await logAudit({
      userId,
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

  timing(jobId, "total", performance.now() - totalStartedAt, { malformedRetries });

  return matchResult;
}
