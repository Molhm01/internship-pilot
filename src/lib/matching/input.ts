import type { FactForPrompt } from "@/lib/prompts";

export const DEFAULT_AI_MATCH_MAX_DESCRIPTION_CHARS = 12_000;
export const DEFAULT_AI_MATCH_MAX_PROFILE_FACTS = 40;

const CONTEXT_FACT_TYPES = new Set([
  "education",
  "gpa",
  "graduationDate",
  "experience",
  "project",
  "activity",
]);

const STOP_WORDS = new Set([
  "and", "are", "for", "from", "have", "intern", "internship", "job", "our",
  "that", "the", "this", "with", "will", "you", "your",
]);

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function aiMatchMaxDescriptionChars(): number {
  return boundedInteger(
    process.env.AI_MATCH_MAX_DESCRIPTION_CHARS,
    DEFAULT_AI_MATCH_MAX_DESCRIPTION_CHARS,
    2_000,
    30_000,
  );
}

export function normalizeMatchDescription(
  value: string,
  maxChars = aiMatchMaxDescriptionChars(),
): string {
  const normalized = value
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter((line, index, lines) => line || Boolean(lines[index - 1]))
    .join("\n")
    .trim();
  if (normalized.length <= maxChars) return normalized;
  const candidate = normalized.slice(0, maxChars);
  const boundary = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(". "));
  return `${candidate.slice(0, boundary >= maxChars * 0.75 ? boundary + 1 : maxChars).trim()}\n[Description truncated]`;
}

function tokens(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-z0-9][a-z0-9+.#-]{1,}/g) ?? [])
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  );
}

function relevance(fact: FactForPrompt, jobTokens: Set<string>): number {
  const factTokens = tokens(`${fact.content} ${fact.detail ?? ""}`);
  let score = 0;
  for (const token of factTokens) if (jobTokens.has(token)) score += token.length >= 6 ? 2 : 1;
  return score;
}

export function selectRelevantApprovedFacts(
  facts: FactForPrompt[],
  jobText: string,
  maxFacts = DEFAULT_AI_MATCH_MAX_PROFILE_FACTS,
): FactForPrompt[] {
  const jobTokens = tokens(jobText);
  const ranked = facts.map((fact, index) => ({
    fact,
    index,
    score: relevance(fact, jobTokens),
    context: CONTEXT_FACT_TYPES.has(fact.type),
  }));
  return ranked
    .filter((item) => item.context || item.score > 0)
    .sort((a, b) => Number(b.context) - Number(a.context) || b.score - a.score || a.index - b.index)
    .slice(0, Math.max(1, maxFacts))
    .sort((a, b) => a.index - b.index)
    .map((item) => item.fact);
}
