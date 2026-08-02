import { z } from "zod";
import { FACT_TYPES } from "@/lib/statuses";

export const candidateFactSchema = z.object({
  type: z.enum(FACT_TYPES),
  content: z.string().trim().min(1).max(300),
  detail: z.string().trim().max(1000).nullable().optional(),
});

export const resumeAnalysisResponseSchema = z.object({
  facts: z.array(candidateFactSchema),
});

export type CandidateFact = z.infer<typeof candidateFactSchema>;

const skillItemSchema = z.object({
  skill: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(1000),
  factIds: z.array(z.string()).optional().default([]),
});

export const matchResponseSchema = z.object({
  eligibility: z.enum(["Pass", "Fail", "Unknown"]),
  eligibilityReason: z.string().trim().min(1).max(1000),
  matchScore: z.number().int().min(0).max(100),
  explanation: z.string().trim().min(1).max(3000),
  recommendation: z.enum(["Apply", "Skip", "Consider"]),
  skillsSupported: z.array(skillItemSchema),
  skillsNeedConfirmation: z.array(skillItemSchema),
  skillsToLearn: z.array(skillItemSchema),
  skillsNeverAdd: z.array(skillItemSchema),
  tailoringPreview: z.array(z.string().trim().min(1).max(400)),
});

export type MatchResponse = z.infer<typeof matchResponseSchema>;
export type SkillItem = z.infer<typeof skillItemSchema>;

const skillItemJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["skill", "reason", "factIds"],
  properties: {
    skill: { type: "string" },
    reason: { type: "string" },
    factIds: { type: "array", items: { type: "string" } },
  },
} as const;

export const matchResponseJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "eligibility",
    "eligibilityReason",
    "matchScore",
    "explanation",
    "recommendation",
    "skillsSupported",
    "skillsNeedConfirmation",
    "skillsToLearn",
    "skillsNeverAdd",
    "tailoringPreview",
  ],
  properties: {
    eligibility: { type: "string", enum: ["Pass", "Fail", "Unknown"] },
    eligibilityReason: { type: "string" },
    matchScore: { type: "integer", minimum: 0, maximum: 100 },
    explanation: { type: "string" },
    recommendation: { type: "string", enum: ["Apply", "Skip", "Consider"] },
    skillsSupported: { type: "array", items: skillItemJsonSchema },
    skillsNeedConfirmation: { type: "array", items: skillItemJsonSchema },
    skillsToLearn: { type: "array", items: skillItemJsonSchema },
    skillsNeverAdd: { type: "array", items: skillItemJsonSchema },
    tailoringPreview: { type: "array", items: { type: "string" } },
  },
};

const QUALIFICATION_STOP_WORDS = new Set([
  "a", "an", "and", "degree", "experience", "in", "knowledge", "of",
  "or", "programming", "proficiency", "skill", "skills", "the", "with",
]);

function qualificationTokens(value: string): string[] {
  return Array.from(new Set(
    (value.toLowerCase().match(/[a-z0-9][a-z0-9+.#-]*/g) ?? [])
      .filter((token) => token.length > 1 && !QUALIFICATION_STOP_WORDS.has(token)),
  ));
}

function allowedFactTypes(qualification: string): Set<string> | null {
  const value = qualification.toLowerCase();
  if (/\b(?:work\s+authori[sz]ation|authori[sz]ed\s+to\s+work|citizenship|visa|sponsorship|security\s+clearance|clearance\s+eligible|work\s+permit)\b/.test(value)) {
    // ResumeFact has no authorization category. These facts belong in the
    // explicitly confirmed application profile and must never be inferred
    // from resume prose.
    return new Set();
  }
  if (/\b(?:gpa|grade point average)\b/.test(value)) return new Set(["gpa"]);
  if (/\b(?:graduation|graduate|class of)\b/.test(value)) {
    return new Set(["graduationDate", "education"]);
  }
  if (/\b(?:course|coursework|class)\b/.test(value)) return new Set(["coursework"]);
  if (/\b(?:degree|bachelor|master|phd|doctorate|major)\b/.test(value)) {
    return new Set(["education"]);
  }
  return null;
}

function directlySupportsQualification(
  qualification: string,
  factText: string,
  factType: string | undefined,
): boolean {
  const allowedTypes = allowedFactTypes(qualification);
  if (allowedTypes && (!factType || !allowedTypes.has(factType))) return false;

  const requiredDuration = qualification.toLowerCase().match(/\b(\d+)\+?\s*(?:years?|yrs?)\b/);
  if (requiredDuration && !new RegExp(`\\b${requiredDuration[1]}\\+?\\s*(?:years?|yrs?)\\b`, "i").test(factText)) {
    return false;
  }

  const tokens = qualificationTokens(qualification);
  if (tokens.length === 0) return false;
  const evidence = factText.toLowerCase();
  if (
    /\brelated\b.*\bengineering\b.*\bdegree\b/.test(qualification.toLowerCase())
    && factType === "education"
    && /\bengineering\b/.test(evidence)
  ) {
    return true;
  }
  const overlap = tokens.filter((token) => evidence.includes(token));
  return tokens.length === 1 ? overlap.length === 1 : overlap.length >= 2;
}

function requiresExactEvidence(qualification: string): boolean {
  return allowedFactTypes(qualification) !== null
    || /\b(?:certification|certified|license|licensed|years?|yrs?)\b/i.test(qualification);
}

// Grounding safety net: any skill claimed as "supported" must cite at least one
// real approved-fact id, and that fact's text must actually contain a
// reasonable overlap with the claimed skill. Otherwise it gets downgraded to
// "needs confirmation" rather than trusted outright — the model's word alone
// is never enough for the highest-confidence bucket.
export function enforceGrounding(
  result: MatchResponse,
  validFactIds: Set<string>,
  factTextById: Map<string, string>,
  factTypeById: Map<string, string> = new Map(),
): MatchResponse {
  const supported: SkillItem[] = [];
  const rejectedClaims: SkillItem[] = [];

  for (const item of result.skillsSupported) {
    const realIds = item.factIds.filter((id) => validFactIds.has(id));
    const hasTextOverlap = realIds.some((id) => directlySupportsQualification(
      item.skill,
      factTextById.get(id) ?? "",
      factTypeById.get(id),
    ));

    if (realIds.length > 0 && hasTextOverlap) {
      supported.push({
        ...item,
        factIds: realIds,
        reason: "Supported by approved profile evidence.",
      });
    } else {
      rejectedClaims.push({
        ...item,
        factIds: [],
        reason: `No approved profile fact directly supports ${item.skill}. Do not represent it as experience or a qualification you have.`,
      });
    }
  }

  const confirmation: SkillItem[] = [];
  for (const item of result.skillsNeedConfirmation) {
    const realIds = item.factIds.filter((id) => validFactIds.has(id));
    const hasDirectEvidence = realIds.some((id) => directlySupportsQualification(
      item.skill,
      factTextById.get(id) ?? "",
      factTypeById.get(id),
    ));
    if (realIds.length === 0 || (requiresExactEvidence(item.skill) && !hasDirectEvidence)) {
      rejectedClaims.push({
        ...item,
        factIds: [],
        reason: `No approved profile fact directly supports ${item.skill}. Do not represent it as experience or a qualification you have.`,
      });
      continue;
    }
    confirmation.push({
      ...item,
      factIds: realIds,
      reason: `Related approved evidence exists, but direct support for ${item.skill} is not confirmed.`,
    });
  }
  const skillsToLearn = result.skillsToLearn.map((item) => ({
    ...item,
    factIds: [],
    reason: `The job requests ${item.skill}, but no approved profile fact supports it. Treat it as a development gap, not a current qualification.`,
  }));
  const skillsNeverAdd = [...rejectedClaims, ...result.skillsNeverAdd].map((item) => ({
    ...item,
    factIds: [],
    reason: `The job requests ${item.skill}, but no approved profile fact supports it. Do not represent it as experience or skill you have.`,
  }));
  const unsupported = [...skillsToLearn, ...skillsNeverAdd];
  const eligibilityReason = [
    `${result.eligibility} based only on the approved profile evidence.`,
    supported.length
      ? `${supported.length} qualification${supported.length === 1 ? " is" : "s are"} directly supported.`
      : "No requested qualification was directly supported.",
    unsupported.length || confirmation.length
      ? `${unsupported.length + confirmation.length} qualification${unsupported.length + confirmation.length === 1 ? " needs" : "s need"} confirmation or has no approved evidence.`
      : "No unsupported qualification was identified.",
  ].join(" ");
  const explanation = supported.length
    ? `Approved profile evidence supports: ${supported.map((item) => item.skill).join(", ")}. Unsupported or unconfirmed qualifications are listed separately and are not attributed to the candidate.`
    : "No approved profile fact directly supports the requested qualifications. Unsupported or unconfirmed qualifications are listed separately and are not attributed to the candidate.";
  const tailoringPreview = supported.flatMap((item) =>
    item.factIds.slice(0, 1).map(() =>
      `Emphasize approved evidence relevant to ${item.skill} without adding unsupported claims.`,
    ),
  ).slice(0, 4);

  return {
    ...result,
    skillsSupported: supported,
    skillsNeedConfirmation: confirmation,
    skillsToLearn,
    skillsNeverAdd,
    eligibilityReason,
    explanation,
    tailoringPreview,
    // Hard safety net: the model must never recommend applying to a job that
    // fails an explicit eligibility requirement, regardless of what it output.
    recommendation: result.eligibility === "Fail" ? "Skip" : result.recommendation,
  };
}
