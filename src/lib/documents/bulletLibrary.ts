import { z } from "zod";
import { prisma } from "@/lib/db";
import { ollamaGenerateJSON } from "@/lib/ollama";

// Only experience/project/activity facts become "bullets" (action-verb resume
// prose). Education/skill/coursework/gpa/graduationDate facts are rendered
// directly from the fact text at document-build time — no LLM involved for
// those at all, so there's zero fabrication risk for the most fact-checkable
// parts of a resume (dates, GPA, degree).
const BULLET_CATEGORIES = ["experience", "project", "activity"] as const;

const bulletResponseSchema = z.object({
  bullets: z.array(
    z.object({
      category: z.enum(BULLET_CATEGORIES),
      text: z.string().trim().min(1).max(300),
      factIds: z.array(z.string()).min(1),
    }),
  ),
});

function buildPrompt(facts: { id: string; type: string; content: string; detail: string | null }[]): string {
  const factList = facts
    .map((f) => `- [${f.id}] (${f.type}) ${f.content}${f.detail ? ` — ${f.detail}` : ""}`)
    .join("\n");

  return `You are building a reusable resume bullet library from ONLY the approved facts below. Never invent anything not stated in a fact — no new numbers, tools, outcomes, or responsibilities.

For each "experience" or "project" fact, write exactly one strong resume bullet (action-verb style, max ~20 words) that paraphrases ONLY that fact. For "activity" facts, write one short bullet each. You may combine two closely related facts into one bullet only if it reads naturally as a single accomplishment — in that case cite both fact ids.

APPROVED FACTS:
${factList}

Return ONLY valid JSON, no commentary, no markdown fences:
{ "bullets": [ { "category": "experience", "text": "string", "factIds": ["id1"] } ] }`;
}

export type GenerateBulletsResult = { count: number; rejected: number };

// Regenerates the entire bullet library from the current set of approved
// facts. Safe to re-run after new facts are approved.
export async function generateBulletLibrary(userId: string): Promise<GenerateBulletsResult> {
  const facts = await prisma.resumeFact.findMany({
    where: {
      userId,
      status: { in: ["approved", "edited"] },
      type: { in: BULLET_CATEGORIES as unknown as string[] },
    },
  });
  if (facts.length === 0) {
    throw new Error("No approved experience/project/activity facts yet — approve some on the Profile page first.");
  }

  const prompt = buildPrompt(facts);
  const raw = await ollamaGenerateJSON(prompt, { timeoutMs: 180_000 });
  const parsed = bulletResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("The AI model returned bullets in an unexpected format. Try again.");
  }

  const validIds = new Set(facts.map((f) => f.id));

  // Scoped to this user. Unscoped, one person regenerating their own library
  // deleted every other account's bullets as well — and since the rows written
  // below carried no owner, whatever survived was visible to everybody.
  await prisma.resumeBullet.deleteMany({ where: { userId } });

  let count = 0;
  let rejected = 0;
  for (const b of parsed.data.bullets) {
    const realIds = b.factIds.filter((id) => validIds.has(id));
    if (realIds.length === 0) {
      rejected++; // cited no real approved fact at all — never store it
      continue;
    }
    await prisma.resumeBullet.create({
      data: { userId, category: b.category, text: b.text, factIds: JSON.stringify(realIds) },
    });
    count++;
  }

  return { count, rejected };
}
