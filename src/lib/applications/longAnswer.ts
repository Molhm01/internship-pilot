import { ollamaGenerateJSON, OllamaError } from "@/lib/ollama";

/**
 * Grounded long-answer generation for free-text/essay application questions.
 *
 * formFiller.ts used to pause on every textarea with no pre-saved answer
 * (stopReason "essay_without_approved_answer") rather than guess — correct,
 * but not the finished product: most essay questions on a real form ARE
 * safely answerable from what the candidate has already told Internship
 * Pilot. This module tries that first, and still pauses (returns
 * `answer: null`) whenever the honest answer would require inventing
 * something.
 *
 * Two answer paths, by design:
 *  - STRUCTURED: relocation/availability/authorization/sponsorship/referral
 *    are read directly off profile fields — never an LLM call, because the
 *    ground truth is a single stored value, not something to compose.
 *  - LLM (essay categories only — why this company/role, a project,
 *    leadership, technical interest): generated from the SAME
 *    "approved" Experience.approvedBullets / Project.approvedSkills the
 *    human already vetted for exactly this purpose (see
 *    ProfileEntriesSection's doc comment: "the agent quotes what the user
 *    wrote rather than composing something new"). The prompt mirrors
 *    buildCompactMatchPrompt's proven grounding contract (src/lib/prompts.ts)
 *    — the same "never invent" instruction that already keeps AI Match
 *    scoring from fabricating skills.
 */

export type EssayCategory =
  | "why_company"
  | "why_role"
  | "project"
  | "leadership"
  | "technical_interest"
  | "relocation_explanation"
  | "availability_explanation"
  | "authorization_explanation"
  | "sponsorship_explanation"
  | "referral_family";

const LLM_CATEGORIES: ReadonlySet<EssayCategory> = new Set([
  "why_company",
  "why_role",
  "project",
  "leadership",
  "technical_interest",
]);

/** Classifies a form field's label into an essay category, or null if it isn't one of these. */
export function classifyEssayQuestion(labelText: string): EssayCategory | null {
  const t = labelText.toLowerCase();

  if (/why (do you want to|are you interested in|would you like to)?\s*(work|apply|join).*(here|this company|us\b)/.test(t) || /why (this|our) company/.test(t)) {
    return "why_company";
  }
  if (/why (this|the) role|why (are you interested in|do you want) this (role|position)|what interests you about this (role|position)/.test(t)) {
    return "why_role";
  }
  if (/describe a (relevant )?project|tell us about a project|project you('| a)re proud of/.test(t)) {
    return "project";
  }
  if (/leadership|led a team|team(work)? experience|describe a time you (led|worked in a team)/.test(t)) {
    return "leadership";
  }
  if (/technical interest|what excites you about|what interests you technically|why (are you interested in|does) (this field|this technology)/.test(t)) {
    return "technical_interest";
  }
  if (/relocat/.test(t) && /(explain|describe|tell us|why|comment)/.test(t)) return "relocation_explanation";
  if (/availab|start date|when (can|are) you (start|available)/.test(t) && /(explain|describe|tell us|why|comment)/.test(t)) {
    return "availability_explanation";
  }
  if (/(work authoriz|eligib.*to work|legally (able|authorized) to work)/.test(t) && /(explain|describe|elaborat)/.test(t)) {
    return "authorization_explanation";
  }
  if (/sponsorship/.test(t) && /(explain|describe|elaborat)/.test(t)) return "sponsorship_explanation";
  if (/(relative|family member).*(work|employ)|do you know anyone (who works|employed)|referral|how did you (hear|learn) about (this|the) (role|position|job)|were you referred/.test(t)) {
    return "referral_family";
  }
  return null;
}

export type LongAnswerFacts = {
  jobTitle: string;
  company: string;
  jobDescription: string;
  school: string | null;
  degree: string | null;
  experiences: ReadonlyArray<{ employer: string; title: string | null; approvedBullets: string[] }>;
  projects: ReadonlyArray<{ name: string; description: string | null; approvedSkills: string[] }>;
  willingToRelocate: boolean | null;
  internshipTermAvailability: string | null;
  workAuthorization: string | null;
  requiresSponsorship: boolean | null;
  companyRelationship: {
    hasReferral: boolean | null;
    referralName: string | null;
    referralRelationship: string | null;
    familyMemberEmployed: boolean | null;
  } | null;
};

export type LongAnswerResult = {
  answer: string | null; // null => no grounded answer; caller must pause, never guess
  source: "structured" | "llm" | "unknown";
};

function structuredAnswer(category: EssayCategory, facts: LongAnswerFacts): string | null {
  switch (category) {
    case "relocation_explanation":
      if (facts.willingToRelocate === null || facts.willingToRelocate === undefined) return null;
      return facts.willingToRelocate
        ? "Yes, I am willing to relocate for this opportunity."
        : "I am not able to relocate for this role at this time.";
    case "availability_explanation":
      if (!facts.internshipTermAvailability) return null;
      return `I am available starting ${facts.internshipTermAvailability}.`;
    case "authorization_explanation":
      if (!facts.workAuthorization) return null;
      return facts.workAuthorization;
    case "sponsorship_explanation":
      if (facts.requiresSponsorship === null || facts.requiresSponsorship === undefined) return null;
      return facts.requiresSponsorship
        ? "I will require visa sponsorship to work in this role."
        : "I do not require visa sponsorship to work in this role.";
    case "referral_family": {
      const rel = facts.companyRelationship;
      // Never guessed: absent profile data means the question is genuinely
      // unanswered, not "no" — see the explicit rule this module is built to
      // satisfy ("Do you have a relative at this company? pause/ask user.").
      if (!rel) return null;
      if (rel.hasReferral && rel.referralName) {
        return `Yes — I was referred by ${rel.referralName}${rel.referralRelationship ? ` (${rel.referralRelationship})` : ""}.`;
      }
      if (rel.familyMemberEmployed === true) return "Yes, I have a family member who works at this company.";
      if (rel.hasReferral === false && rel.familyMemberEmployed === false) {
        return "No, I do not have a referral or a family connection at this company.";
      }
      return null;
    }
    default:
      return null;
  }
}

function buildLlmPrompt(category: EssayCategory, facts: LongAnswerFacts): string {
  const experienceList = facts.experiences
    .map((e) => `- ${e.employer}${e.title ? ` (${e.title})` : ""}: ${e.approvedBullets.join("; ") || "(no approved bullets)"}`)
    .join("\n") || "(none)";
  const projectList = facts.projects
    .map((p) => `- ${p.name}: ${p.description ?? ""} ${p.approvedSkills.length ? `[skills: ${p.approvedSkills.join(", ")}]` : ""}`.trim())
    .join("\n") || "(none)";

  const categoryInstruction: Record<typeof category, string> = {
    why_company: "Answer why the candidate wants to work at this specific company, grounded only in what the job description says about the company and the candidate's approved background — never invent enthusiasm for facts not given.",
    why_role: "Answer why the candidate is a fit for and interested in this specific role, grounded only in the job description and approved facts.",
    project: "Describe ONE relevant project from the approved PROJECTS list below. If PROJECTS is empty, this is not answerable.",
    leadership: "Describe a leadership or teamwork example, using ONLY approved EXPERIENCE bullets that describe leading or working in a team. If none of the approved bullets describe leadership/teamwork, this is not answerable.",
    technical_interest: "Answer what technically interests the candidate about this role, grounded only in the job description and the candidate's approved EXPERIENCE/PROJECTS.",
  } as Record<EssayCategory, string>;

  return `Write a short (2-4 sentence) first-person application answer. Use ONLY the approved facts below. Never invent employers, projects, skills, dates, degrees, leadership examples, or company knowledge not stated in the job description. If the approved facts do not support a genuine answer to this category, set "answerable" to false and leave "answer" empty — do not write a generic or padded answer to compensate for missing evidence.

CATEGORY: ${category}
INSTRUCTION: ${categoryInstruction[category]}

APPROVED EXPERIENCE:
${experienceList}

APPROVED PROJECTS:
${projectList}

EDUCATION: ${facts.school ?? "unknown"}${facts.degree ? `, ${facts.degree}` : ""}

JOB
Title: ${facts.jobTitle}
Company: ${facts.company}
${facts.jobDescription.slice(0, 2000)}

Return compact JSON only: {"answerable":true|false,"answer":"grounded first-person answer, or empty string if not answerable"}`;
}

type LlmAnswerResponse = { answerable?: boolean; answer?: string };

const runCache = new Map<string, LongAnswerResult>();

/** Clears the per-process reuse cache — tests only, so runs don't leak between cases. */
export function __clearLongAnswerCacheForTests(): void {
  runCache.clear();
}

/**
 * Cache key intentionally includes jobId: "why this company" is genuinely
 * different across employers, so a cached answer must never leak from one
 * job's form to another's. Project/leadership answers describe the
 * candidate's own history and would be safe to reuse across jobs too, but
 * are kept job-scoped here as well for one simple, unsurprising rule rather
 * than a second, more permissive cache policy.
 */
export async function generateLongAnswer(
  category: EssayCategory,
  jobId: string,
  facts: LongAnswerFacts,
  generateJson: typeof ollamaGenerateJSON = ollamaGenerateJSON,
): Promise<LongAnswerResult> {
  const structured = structuredAnswer(category, facts);
  if (structured !== null) return { answer: structured, source: "structured" };
  if (!LLM_CATEGORIES.has(category)) return { answer: null, source: "unknown" };

  const cacheKey = `${jobId}:${category}`;
  const cached = runCache.get(cacheKey);
  if (cached) return cached;

  let result: LongAnswerResult;
  try {
    const prompt = buildLlmPrompt(category, facts);
    const raw = await generateJson<LlmAnswerResponse>(prompt, { temperature: 0.2, timeoutMs: 120_000 });
    const answer = typeof raw.answer === "string" ? raw.answer.trim() : "";
    result = raw.answerable === true && answer ? { answer, source: "llm" } : { answer: null, source: "unknown" };
  } catch (error) {
    // Ollama unreachable/invalid output — never fabricate as a fallback.
    if (error instanceof OllamaError || error instanceof Error) {
      result = { answer: null, source: "unknown" };
    } else {
      throw error;
    }
  }

  runCache.set(cacheKey, result);
  return result;
}
