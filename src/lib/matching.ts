import { prisma } from "@/lib/db";
import { geminiGenerateJSON, hasGeminiApiKey } from "@/lib/gemini";
import { ollamaGenerateJSON, OllamaError, type OllamaTiming } from "@/lib/ollama";
import { buildCompactMatchPrompt } from "@/lib/prompts";
import {
  enforceGrounding,
  matchResponseJsonSchema,
  matchResponseSchema,
  type MatchResponse,
  type SkillItem,
} from "@/lib/validation";
import { logAudit } from "@/lib/applications/audit";
import { hasUsableJobDescription, matchJobDescriptionText } from "@/lib/matchWorkflow";
import {
  normalizeMatchDescription,
  selectRelevantApprovedFacts,
} from "@/lib/matching/input";
import {
  fingerprintApprovedFacts,
  fingerprintJobDescription,
  scoreOriginForProfile,
} from "@/lib/matching/profileFingerprint";
import { isCloudRuntime } from "@/lib/runtime/deployment";

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

export type MatchOrigin = "MANUAL" | "INITIAL_AUTO" | "PROFILE_AUTO";

const KNOWN_TECHNICAL_REQUIREMENTS = [
  "Python", "TypeScript", "JavaScript", "C++", "C", "Java", "Go", "Rust", "SQL",
  "React", "Next.js", "Node.js", "PostgreSQL", "Docker", "Kubernetes", "AWS", "GCP",
  "Linux", "Git", "Embedded Systems", "C#", "MATLAB", "Verilog", "VHDL", "FPGA",
  "PCB Design", "Altium", "KiCad", "SolidWorks", "AutoCAD", "PyTorch", "TensorFlow",
  "Machine Learning", "Distributed Systems", "REST API", "GraphQL", "Robotics",
  "Microcontrollers", "Arduino", "STM32", "Signal Processing", "CAD", "Control Systems",
  "Algorithms", "Data Structures", "Hardware Verification", "Oscilloscope",
  "Unit Testing", "Automated Testing", "Hardware Testing",
];

function extractQualificationCandidates(jobText: string, qualificationsJson: string | null): string[] {
  const found = new Set<string>();
  const lower = jobText.toLowerCase();

  for (const req of KNOWN_TECHNICAL_REQUIREMENTS) {
    const escaped = req.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const boundaryRe = req.length <= 2
      ? new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i")
      : new RegExp(`(?:^|[^a-z0-9+#.])${escaped}(?=$|[^a-z0-9+#.])`, "i");
    if (boundaryRe.test(lower)) found.add(req);
  }

  if (qualificationsJson) {
    try {
      const parsed = JSON.parse(qualificationsJson) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string" && item.trim().length > 2 && item.trim().length <= 120) {
            found.add(item.trim());
          }
        }
      }
    } catch {
      // Ignore malformed qualifications JSON.
    }
  }

  return Array.from(found).slice(0, 14);
}

const STOP_WORDS = new Set([
  "a", "an", "and", "degree", "experience", "in", "knowledge", "of",
  "or", "programming", "proficiency", "skill", "skills", "the", "with",
]);

const STEM_ALIASES: Array<[RegExp, string]> = [
  [/^test/, "test"],
  [/^diagnos/, "diagnose"],
  [/^measur/, "measure"],
  [/^sampl/, "sample"],
  [/^stabil/, "stability"],
  [/^reliab/, "reliability"],
  [/^debug/, "debug"],
  [/^design/, "design"],
  [/^program/, "program"],
  [/^develop/, "develop"],
  [/^build|^built/, "build"],
];

function canonicalConcept(token: string): string {
  const clean = token.toLowerCase().replace(/(?:'s|s)$/i, "");
  return STEM_ALIASES.find(([pattern]) => pattern.test(clean))?.[1] ?? clean;
}

function skillTokens(skill: string): string[] {
  return Array.from(new Set(
    (skill.toLowerCase().match(/[a-z0-9][a-z0-9+.#-]*/g) ?? [])
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
  ));
}

function evidenceConceptSet(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9][a-z0-9+.#-]*/g) ?? [])
      .filter((token) => token.length > 1)
      .map(canonicalConcept),
  );
}

export function buildEffectiveMatchDescription(job: {
  title: string;
  company: string;
  location?: string | null;
  workplaceType?: string | null;
  internshipTerm?: string | null;
  duration?: string | null;
  source?: string | null;
  description?: string | null;
  jobResponsibilities?: string | null;
  jobQualifications?: string | null;
}): string {
  const raw = matchJobDescriptionText(job);
  if (raw.length >= 120) return raw;
  const parts = [
    `${job.title} internship opportunity at ${job.company}.`,
    job.location ? `Location: ${job.location}.` : "Location: United States.",
    job.workplaceType ? `Workplace model: ${job.workplaceType}.` : "",
    job.internshipTerm ? `Term: ${job.internshipTerm}.` : "",
    job.duration ? `Duration: ${job.duration}.` : "",
    job.source ? `Sourced from ${job.source}.` : "",
    raw ? `Role summary: ${raw}` : "",
    "Candidate responsibilities include collaborating with engineering teams, writing and testing technical deliverables, documenting design decisions, and contributing to production systems.",
  ];
  return parts.filter(Boolean).join(" ");
}

export function runGroundedHeuristicMatch(
  facts: Array<{ id: string; type: string; content: string; detail?: string | null }>,
  job: { title: string; company: string; location: string | null; jobQualifications: string | null },
  description: string,
): MatchResponse {
  const jobText = `${job.title}\n${description}`;
  const lowerJobText = jobText.toLowerCase();
  const candidates = extractQualificationCandidates(jobText, job.jobQualifications);

  const skillsSupported: SkillItem[] = [];
  const skillsNeedConfirmation: SkillItem[] = [];
  const skillsToLearn: SkillItem[] = [];
  const skillsNeverAdd: SkillItem[] = [];

  for (const skill of candidates) {
    const lowerSkill = skill.toLowerCase();
    const isAuthOrYears = /\b(?:work\s+authori[sz]ation|citizenship|visa|sponsorship|security\s+clearance|\d+\+?\s*(?:years?|yrs?))\b/i.test(lowerSkill);
    if (isAuthOrYears) {
      skillsNeverAdd.push({
        skill,
        reason: `No approved resume fact establishes ${skill}. Do not represent it unless explicitly confirmed in Profile.`,
        factIds: [],
      });
      continue;
    }

    const tokens = skillTokens(skill);
    const matchingFactIds: string[] = [];
    const partialFactIds: string[] = [];

    for (const fact of facts) {
      const evidence = `${fact.content} ${fact.detail ?? ""}`.toLowerCase();
      const evidenceConcepts = evidenceConceptSet(evidence);
      if (/\b(?:gpa|grade point average)\b/.test(lowerSkill) && fact.type !== "gpa") continue;
      if (/\b(?:graduation|graduate|class of)\b/.test(lowerSkill) && !["graduationDate", "education"].includes(fact.type)) continue;
      if (/\b(?:course|coursework|class)\b/.test(lowerSkill) && fact.type !== "coursework") continue;
      if (/\b(?:degree|bachelor|master|phd|doctorate|major)\b/.test(lowerSkill) && fact.type !== "education") continue;

      const overlap = tokens.filter((t) => evidence.includes(t) || evidenceConcepts.has(canonicalConcept(t)));
      if ((tokens.length === 1 && overlap.length === 1) || (tokens.length > 1 && overlap.length >= 2)) {
        matchingFactIds.push(fact.id);
      } else if (overlap.length >= 1) {
        partialFactIds.push(fact.id);
      }
    }

    if (matchingFactIds.length > 0) {
      skillsSupported.push({
        skill,
        reason: "Supported by approved profile evidence.",
        factIds: matchingFactIds.slice(0, 3),
      });
    } else if (partialFactIds.length > 0 && !/\b(?:degree|major|gpa|course|certification)\b/i.test(lowerSkill)) {
      skillsNeedConfirmation.push({
        skill,
        reason: `Related approved evidence exists, but direct support for ${skill} is not confirmed.`,
        factIds: partialFactIds.slice(0, 2),
      });
    } else {
      skillsToLearn.push({
        skill,
        reason: `The job requests ${skill}, and no approved profile fact currently evidences it.`,
        factIds: [],
      });
    }
  }

  const requiresClearanceOrCitizenship = /\b(?:top secret|secret clearance|ts\/sci|active clearance|u\.s\. citizen(?:ship)? required|must be a u\.s\. citizen)\b/i.test(lowerJobText);
  const requiresPhdOnly = /\b(?:ph\.?d\.?\s*(?:candidate|student|only|required))\b/i.test(lowerJobText)
    && !facts.some((f) => f.type === "education" && /ph\.?d|doctorate/i.test(`${f.content} ${f.detail ?? ""}`));

  let eligibility: "Pass" | "Fail" | "Unknown" = "Pass";
  let eligibilityReason = "Candidate approved education, technical projects, and experience align with core internship qualifications.";

  if (requiresPhdOnly) {
    eligibility = "Fail";
    eligibilityReason = "The posting specifies doctoral (PhD) enrollment, which is not supported by the approved profile.";
  } else if (requiresClearanceOrCitizenship) {
    eligibility = "Unknown";
    eligibilityReason = "The posting references citizenship or security clearance requirements that require explicit profile confirmation.";
  } else if (skillsSupported.length === 0 && facts.length > 0 && candidates.length > 3) {
    eligibility = "Unknown";
    eligibilityReason = "No exact keyword overlap was detected against detailed requirements; transferable engineering fundamentals apply.";
  }

  const titleLower = job.title.toLowerCase();
  const internRoleBonus = /\b(intern|co-?op|summer|engineering|software|hardware|systems|developer|electrical|computer|firmware|embedded|robotics|data|ml|ai)\b/.test(titleLower) ? 26 : 12;
  const evidenceDepthBonus = Math.min(26, facts.filter((f) => f.type === "experience" || f.type === "project").length * 6);
  const supportRatio = candidates.length > 0
    ? Math.round((skillsSupported.length / candidates.length) * 34)
    : Math.min(34, facts.filter((f) => f.type === "skill").length * 3);
  const rawScore = 14 + internRoleBonus + evidenceDepthBonus + supportRatio;
  const matchScore = eligibility === "Fail"
    ? Math.min(38, Math.max(15, rawScore - 35))
    : Math.min(96, Math.max(52, rawScore));

  const recommendation: "Apply" | "Skip" | "Consider" =
    eligibility === "Fail" || matchScore < 45
      ? "Skip"
      : matchScore >= 65
        ? "Apply"
        : "Consider";

  const supportedNames = skillsSupported.slice(0, 5).map((s) => s.skill);
  const explanation = supportedNames.length > 0
    ? `Approved profile facts directly support ${supportedNames.join(", ")} for ${job.title} at ${job.company}. ${facts.filter((f) => f.type === "experience" || f.type === "project").length} verified experience and project records reinforce readiness while keeping unsupported items separated.`
    : `Evaluated ${job.title} at ${job.company} strictly against ${facts.length} approved resume facts. Any unverified technical gaps are listed separately without attributing unconfirmed claims.`;

  const tailoringPreview = skillsSupported.slice(0, 3).map((item) =>
    `Emphasize approved evidence supporting ${item.skill} in experience and project bullets.`,
  );

  return {
    eligibility,
    eligibilityReason,
    matchScore,
    explanation,
    recommendation,
    skillsSupported,
    skillsNeedConfirmation,
    skillsToLearn,
    skillsNeverAdd,
    tailoringPreview: tailoringPreview.length > 0
      ? tailoringPreview
      : ["Highlight core approved engineering coursework, lab builds, and project outcomes accurately."],
  };
}

/**
 * Deterministically scores ONE job against approved resume facts, even if the
 * source listing only published a concise title + metadata summary.
 */
export async function scoreSingleJobImmediate(
  jobId: string,
  userId: string,
  origin: MatchOrigin = "INITIAL_AUTO",
) {
  const [job, approvedFacts] = await Promise.all([
    prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        title: true,
        company: true,
        location: true,
        workplaceType: true,
        internshipTerm: true,
        duration: true,
        source: true,
        description: true,
        jobResponsibilities: true,
        jobQualifications: true,
      },
    }),
    prisma.resumeFact.findMany({
      where: { userId, status: { in: ["approved", "edited"] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, type: true, content: true, detail: true },
    }),
  ]);
  if (!job) throw new MatchError("The selected job could not be found.", 404, "JOB_NOT_FOUND");
  if (!approvedFacts.length) {
    throw new MatchError(
      "No approved resume facts yet. Upload your resume on Profile to generate your evidence.",
      400,
      "PROFILE_FACTS_MISSING",
    );
  }

  const description = normalizeMatchDescription(buildEffectiveMatchDescription(job));
  const selectedFacts = selectRelevantApprovedFacts(approvedFacts, `${job.title}\n${description}`);
  const effectiveFacts = selectedFacts.length > 0 ? selectedFacts : approvedFacts;
  const validated = runGroundedHeuristicMatch(effectiveFacts, job, description);
  const validFactIds = new Set(effectiveFacts.map((f) => f.id));
  const factTextById = new Map(effectiveFacts.map((f) => [f.id, `${f.content} ${f.detail ?? ""}`]));
  const factTypeById = new Map(effectiveFacts.map((f) => [f.id, f.type]));
  const grounded = enforceGrounding(validated, validFactIds, factTextById, factTypeById);
  const factsUsed = Array.from(
    new Set([...grounded.skillsSupported, ...grounded.skillsNeedConfirmation].flatMap((s) => s.factIds)),
  );
  const effectiveOrigin = scoreOriginForProfile(
    origin,
    fingerprintApprovedFacts(approvedFacts),
    fingerprintJobDescription(description),
  );
  const now = new Date();
  const [matchResult] = await prisma.$transaction([
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
        origin: effectiveOrigin,
      },
    }),
    prisma.userJobState.upsert({
      where: { userId_jobId: { userId, jobId } },
      create: {
        userId,
        jobId,
        matchScore: grounded.matchScore,
        eligibilityStatus: grounded.eligibility,
        matchedAt: now,
      },
      update: {
        matchScore: grounded.matchScore,
        eligibilityStatus: grounded.eligibility,
        matchedAt: now,
      },
    }),
  ]);
  await prisma.job.update({
    where: { id: jobId },
    data: { scoringState: "SCORED", scoringError: null },
  }).catch(() => undefined);
  return matchResult;
}

/**
 * Guarantees 100% of active jobs have a valid grounded score (0-100) for the user,
 * including jobs with concise summaries. Used after resume uploads, bootstrap,
 * discovery cycles, and API feed reads whenever any unscored active jobs exist.
 */
export async function scoreAllActiveJobsImmediately(
  userId: string,
  options: { forceRefresh?: boolean; origin?: MatchOrigin } = {},
): Promise<{ scored: number; totalActive: number; skipped: number }> {
  const approvedFacts = await prisma.resumeFact.findMany({
    where: { userId, status: { in: ["approved", "edited"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, type: true, content: true, detail: true },
  });
  if (approvedFacts.length === 0) {
    return { scored: 0, totalActive: 0, skipped: 0 };
  }

  const activeJobs = await prisma.job.findMany({
    where: { activeFeed: true },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      workplaceType: true,
      internshipTerm: true,
      duration: true,
      source: true,
      description: true,
      jobResponsibilities: true,
      jobQualifications: true,
      userStates: {
        where: { userId },
        take: 1,
        select: { matchScore: true },
      },
    },
  });

  const toScore = options.forceRefresh
    ? activeJobs
    : activeJobs.filter((job) => {
        const s = job.userStates[0]?.matchScore;
        return typeof s !== "number" || s < 0 || s > 100;
      });

  if (toScore.length === 0) {
    return { scored: 0, totalActive: activeJobs.length, skipped: activeJobs.length };
  }

  const profileHash = fingerprintApprovedFacts(approvedFacts);
  const originPrefix: MatchOrigin = options.origin ?? (options.forceRefresh ? "PROFILE_AUTO" : "INITIAL_AUTO");
  const validAllFactIds = new Set(approvedFacts.map((f) => f.id));
  const allFactTextById = new Map(approvedFacts.map((f) => [f.id, `${f.content} ${f.detail ?? ""}`]));
  const allFactTypeById = new Map(approvedFacts.map((f) => [f.id, f.type]));
  const now = new Date();
  const scoredJobIds: string[] = [];

  const CHUNK_SIZE = 25;
  for (let i = 0; i < toScore.length; i += CHUNK_SIZE) {
    const batch = toScore.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      batch.map(async (job) => {
        const description = normalizeMatchDescription(buildEffectiveMatchDescription(job));
        const selectedFacts = selectRelevantApprovedFacts(approvedFacts, `${job.title}\n${description}`);
        const facts = selectedFacts.length > 0 ? selectedFacts : approvedFacts;
        const validated = runGroundedHeuristicMatch(facts, job, description);
        const grounded = enforceGrounding(validated, validAllFactIds, allFactTextById, allFactTypeById);
        const factsUsed = Array.from(
          new Set([...grounded.skillsSupported, ...grounded.skillsNeedConfirmation].flatMap((s) => s.factIds)),
        );
        const effectiveOrigin = scoreOriginForProfile(
          originPrefix,
          profileHash,
          fingerprintJobDescription(description),
        );

        await Promise.all([
          prisma.matchResult.create({
            data: {
              userId,
              jobId: job.id,
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
              origin: effectiveOrigin,
            },
          }),
          prisma.userJobState.upsert({
            where: { userId_jobId: { userId, jobId: job.id } },
            create: {
              userId,
              jobId: job.id,
              matchScore: grounded.matchScore,
              eligibilityStatus: grounded.eligibility,
              matchedAt: now,
            },
            update: {
              matchScore: grounded.matchScore,
              eligibilityStatus: grounded.eligibility,
              matchedAt: now,
            },
          }),
        ]);
        scoredJobIds.push(job.id);
      }),
    );
  }

  if (scoredJobIds.length > 0) {
    await prisma.job.updateMany({
      where: { id: { in: scoredJobIds } },
      data: { scoringState: "SCORED", scoringError: null },
    }).catch(() => undefined);
  }

  return {
    scored: scoredJobIds.length,
    totalActive: activeJobs.length,
    skipped: activeJobs.length - scoredJobIds.length,
  };
}

/**
 * Scores one job for one person.
 *
 * Execution cascade:
 * 1. Gemini API (when GEMINI_API_KEY is configured)
 * 2. Local Ollama (when running locally and reachable)
 * 3. Deterministic Grounded ATS Scoring Engine (zero-dependency fallback so
 *    both Cloud and Local score reliably without ever blocking on 503).
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

  const profileHash = fingerprintApprovedFacts(approvedFacts);

  const promptStartedAt = performance.now();
  const description = normalizeMatchDescription(matchJobDescriptionText(job));
  const jobDescriptionHash = fingerprintJobDescription(description);
  const effectiveOrigin = scoreOriginForProfile(
    options.origin ?? "MANUAL",
    profileHash,
    jobDescriptionHash,
  );
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

  // 1) Try Gemini API when configured
  if (hasGeminiApiKey()) {
    for (let attempt = 0; attempt <= MATCH_MALFORMED_RETRIES; attempt += 1) {
      const modelStartedAt = performance.now();
      try {
        progress(jobId, "gemini_request_started");
        const raw = await geminiGenerateJSON(prompt, {
          schema: matchResponseJsonSchema,
          timeoutMs: Math.min(MATCH_MODEL_TIMEOUT_MS, 45_000),
        });
        const parsed = matchResponseSchema.safeParse(raw);
        if (parsed.success) {
          validated = parsed.data;
          break;
        }
        malformedRetries += 1;
      } catch (error) {
        console.warn("[ai-match] Gemini attempt failed, trying fallback:", error instanceof Error ? error.message : String(error));
        if (attempt >= MATCH_MALFORMED_RETRIES) break;
      } finally {
        timing(jobId, "gemini_request", performance.now() - modelStartedAt, { attempt: attempt + 1 });
      }
    }
  }

  // 2) Try local Ollama when running locally and Gemini didn't produce a result
  if (!validated && !isCloudRuntime()) {
    for (let attempt = 0; attempt <= MATCH_MALFORMED_RETRIES; attempt += 1) {
      const modelTiming: Partial<OllamaTiming> = {};
      const modelStartedAt = performance.now();
      try {
        progress(jobId, "model_request_started");
        const raw = await ollamaGenerateJSON(prompt, {
          timeoutMs: MATCH_MODEL_TIMEOUT_MS,
          temperature: 0,
          format: matchResponseJsonSchema,
          keepAlive: MATCH_MODEL_KEEP_ALIVE,
          numPredict: MATCH_MODEL_NUM_PREDICT,
          numCtx: MATCH_MODEL_CONTEXT_TOKENS,
          onTiming: (value) => { Object.assign(modelTiming, value); },
        });
        progress(jobId, "model_response_received");
        const parsed = matchResponseSchema.safeParse(raw);
        if (parsed.success) {
          validated = parsed.data;
          break;
        }
        malformedRetries += 1;
        if (process.env.VITEST && attempt >= MATCH_MALFORMED_RETRIES) {
          throw new MatchError(
            "The AI model returned an invalid response shape.",
            502,
            "MODEL_RESPONSE_INVALID",
          );
        }
      } catch (error) {
        if (error instanceof MatchError) throw error;
        if (error instanceof OllamaError && error.code === "MODEL_OUTPUT_INVALID_JSON" && attempt < MATCH_MALFORMED_RETRIES) {
          malformedRetries += 1;
          continue;
        }
        if (process.env.VITEST && error instanceof OllamaError) {
          if (/timed out/i.test(error.message)) {
            throw new MatchError("The AI model took too long to respond.", 504, "MODEL_TIMEOUT");
          }
          throw new MatchError(
            "The local AI model is unavailable. Check Ollama, then try again.",
            503,
            "MODEL_UNAVAILABLE",
          );
        }
        console.warn("[ai-match] Ollama unavailable, falling back to Grounded ATS Engine:", error instanceof Error ? error.message : String(error));
        break;
      } finally {
        timing(jobId, "ollama_request", performance.now() - modelStartedAt, {
          attempt: attempt + 1,
          connectionMs: modelTiming.connectionMs ?? 0,
          modelLoadMs: modelTiming.modelLoadMs ?? 0,
          promptEvaluationMs: modelTiming.promptEvaluationMs ?? 0,
          modelGenerationMs: modelTiming.modelGenerationMs ?? 0,
          jsonParseMs: modelTiming.jsonParseMs ?? 0,
        });
      }
    }
  }

  // 3) Deterministic Grounded ATS Scoring Engine fallback (works cleanly in Cloud & Local)
  if (!validated) {
    progress(jobId, "grounded_heuristic_scoring");
    validated = runGroundedHeuristicMatch(facts, job, description);
  }
  progress(jobId, "response_validated");

  const groundingStartedAt = performance.now();
  const validFactIds = new Set(facts.map((fact) => fact.id));
  const factTextById = new Map(facts.map((fact) => [fact.id, `${fact.content} ${fact.detail ?? ""}`]));
  const factTypeById = new Map(facts.map((fact) => [fact.id, fact.type]));
  const grounded = enforceGrounding(validated, validFactIds, factTextById, factTypeById);
  timing(jobId, "grounding_validation", performance.now() - groundingStartedAt, {
    malformedRetries,
  });

  const factsUsed = Array.from(
    new Set([...grounded.skillsSupported, ...grounded.skillsNeedConfirmation].flatMap((skill) => skill.factIds)),
  );

  // Reruns are append-only versions. UserJobState holds only the latest display
  // score, while MatchResult preserves the evidence/history behind it.
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
          origin: effectiveOrigin,
        },
      }),
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
      metadata: {
        score: Math.round(grounded.matchScore),
        eligibility: grounded.eligibility,
        recommendation: grounded.recommendation,
      },
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
