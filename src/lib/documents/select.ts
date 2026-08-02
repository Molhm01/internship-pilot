import { z } from "zod";
import { ollamaGenerateJSON } from "@/lib/ollama";

type BulletForPrompt = { id: string; category: string; text: string };
type FactForPrompt = { id: string; type: string; content: string; detail: string | null };

const selectionSchema = z.object({
  experienceBulletIds: z.array(z.string()).default([]),
  projectBulletIds: z.array(z.string()).default([]),
  activityBulletIds: z.array(z.string()).default([]),
  coverLetterParagraphs: z.array(z.string().trim().min(1).max(1100)).min(2).max(4).default([]),
});
export type ContentSelection = z.infer<typeof selectionSchema>;
export const DOCUMENT_SELECTION_MODEL_TIMEOUT_MS = 30_000;

function buildPrompt(
  job: { title: string; company: string; description: string },
  bullets: BulletForPrompt[],
  facts: FactForPrompt[],
): string {
  const bulletList = bullets.map((b) => `- [${b.id}] (${b.category}) ${b.text}`).join("\n") || "(none available)";
  const factList = facts.map((f) => `- (${f.type}) ${f.content}${f.detail ? ` — ${f.detail}` : ""}`).join("\n");

  return `You are tailoring an internship application using ONLY pre-approved, pre-written content. You may NOT write new resume bullets — you may only SELECT existing bullet ids from the list below, in priority order (most relevant to this job first, cap at 6 total across all categories combined).

For the cover letter, write 3 or 4 short paragraphs totaling 190-250 words (the template adds the greeting, thank-you, and signature). Sound like a thoughtful college engineering student. Use 2 or 3 concrete approved experiences, explain how that work connects to this role, and give one specific reason the actual work described in the posting is interesting. Never invent a skill, project, tool, employer, number, company fact, or responsibility. Do not copy job-description sentences. Stay within the requested word range.

Do not include a greeting, closing, signature, or generic thank-you; the fixed template supplies those. Avoid corporate or repetitive AI phrases, including "I am eager to contribute", "My technical foundation is built on", "I am particularly drawn to", "I am passionate about", "fast-paced environment", "interdisciplinary teams", "unique opportunity", "my skills align perfectly", and "ideal candidate". Prefer plain sentences about what the candidate built, repaired, tested, learned, or wants to learn.

JOB:
Title: ${job.title}
Company: ${job.company}
Description:
"""
${job.description}
"""

AVAILABLE BULLETS (select ids only, do not alter the text):
${bulletList}

APPROVED FACTS (for cover letter grounding — do not invent beyond these):
${factList}

Return ONLY valid JSON, no commentary, no markdown fences:
{
  "experienceBulletIds": ["id1"],
  "projectBulletIds": ["id2"],
  "activityBulletIds": [],
  "coverLetterParagraphs": ["string", "string"]
}`;
}

export async function selectContentForJob(
  job: { title: string; company: string; description: string },
  bullets: BulletForPrompt[],
  facts: FactForPrompt[],
): Promise<ContentSelection> {
  const prompt = buildPrompt(job, bullets, facts);
  const raw = await ollamaGenerateJSON(prompt, { timeoutMs: DOCUMENT_SELECTION_MODEL_TIMEOUT_MS });
  const parsed = selectionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("The AI model returned document content in an unexpected format. Try again.");
  }

  // Defense in depth: only ids that actually exist in the provided bullet
  // list survive, exactly like the skill-grounding check in validation.ts —
  // the model's word alone is never enough.
  const validIds = new Set(bullets.map((b) => b.id));
  return {
    experienceBulletIds: parsed.data.experienceBulletIds.filter((id) => validIds.has(id)),
    projectBulletIds: parsed.data.projectBulletIds.filter((id) => validIds.has(id)),
    activityBulletIds: parsed.data.activityBulletIds.filter((id) => validIds.has(id)),
    coverLetterParagraphs: parsed.data.coverLetterParagraphs,
  };
}

// Normalizes a token for comparison: lowercase, drop a trailing possessive
// ('s), then strip every remaining non-alphanumeric character. This makes
// "B.S." / "B.S" / "BS", and "Astranis's" / "Astranis", compare equal —
// otherwise punctuation differences between how a fact was written and how
// the model phrased a sentence cause spurious "unsupported" rejections.
function normalizeToken(w: string): string {
  return w
    .toLowerCase()
    .replace(/'s$/, "")
    .replace(/[^a-z0-9]/g, "");
}

function groundedCorpus(facts: FactForPrompt[], bullets: BulletForPrompt[], allowedContext: string[]): Set<string> {
  const words = new Set<string>();
  const addFrom = (text: string) => {
    for (const w of text.toLowerCase().split(/[^a-z0-9+.#]+/)) {
      if (w.length > 2) words.add(normalizeToken(w));
    }
  };
  for (const f of facts) addFrom(`${f.content} ${f.detail ?? ""}`);
  for (const b of bullets) addFrom(b.text);
  // The job title and company name aren't candidate qualifications — quoting
  // "what job you're applying to" back isn't a fabrication risk, so those
  // words are always allowed without needing to appear in a resume fact.
  for (const c of allowedContext) addFrom(c);
  return words;
}

export type GroundingFilterResult = { kept: string; rejectedSentences: string[] };

// Milestone 5, point 12: "Reject any unsupported sentence." Applied to
// freely-generated cover-letter prose (the one place in this pipeline that
// isn't already constrained to pre-approved bullets by construction).
//
// Earlier version required broad word-overlap for EVERY sentence, which
// rejected perfectly honest framing like "I am writing to express interest
// in the [Job Title] position at [Company]" just because "reliability" and
// "Astranis" don't appear in the candidate's resume facts — but naming the
// job/company isn't a claim about the candidate, so it doesn't need resume
// grounding. What actually needs grounding is a SPECIFIC, checkable claim:
// a named tool/technology/proper noun or a number. A sentence with no such
// claim (pure connective/enthusiasm framing) is left alone; a sentence that
// does make a specific claim must have at least one of those claims traced
// to an approved fact or bullet (or the job/company context).
function extractClaimTokens(sentence: string): string[] {
  const words = sentence.split(/\s+/);
  const tokens: string[] = [];
  words.forEach((raw, i) => {
    const word = raw.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
    if (!word) return;
    if (/\d/.test(word)) {
      tokens.push(normalizeToken(word));
      return;
    }
    // A capitalized word that ISN'T the first word of the sentence is
    // treated as a specific named claim (a tool, technology, or proper
    // noun) — sentence-initial capitalization is just English grammar.
    if (i > 0 && /^[A-Z]/.test(word) && word.length > 2) {
      tokens.push(normalizeToken(word));
    }
  });
  return tokens;
}

export function filterGroundedSentences(
  paragraph: string,
  facts: FactForPrompt[],
  bullets: BulletForPrompt[],
  allowedContext: string[] = [],
): GroundingFilterResult {
  const corpus = groundedCorpus(facts, bullets, allowedContext);
  const sentences = paragraph.split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept: string[] = [];
  const rejected: string[] = [];

  for (const sentence of sentences) {
    const claimTokens = extractClaimTokens(sentence);
    if (claimTokens.length === 0) {
      kept.push(sentence); // pure connective/enthusiasm framing — nothing specific to verify
      continue;
    }
    const anyGrounded = claimTokens.some((t) => corpus.has(t));
    if (anyGrounded) {
      kept.push(sentence);
    } else {
      rejected.push(sentence);
    }
  }

  return { kept: kept.join(" "), rejectedSentences: rejected };
}
