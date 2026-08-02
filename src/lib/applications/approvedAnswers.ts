import { prisma } from "@/lib/db";

export function normalizeQuestionText(label: string): string {
  return label.toLowerCase().replace(/\*/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

// Reuse is intentionally scoped to generic/unclassified questions only
// (see formFiller.ts) — never for work-authorization/sponsorship/clearance/
// EEO categories, which always re-ask unless the user has set a profile
// field explicitly. This is for things like repeated "Why this company?"
// or employer-specific screening questions across applications.
/**
 * Answers are keyed by (owner, question). In local single-user mode the owner
 * is null — the same key the rows created before accounts existed already
 * carry, so nothing has to be migrated for them to keep resolving.
 *
 * `findFirst` rather than `findUnique` because Prisma's compound-unique lookup
 * cannot express a null component, even though SQLite indexes one perfectly
 * well. The pair is still unique; only the way it is queried differs.
 */
export async function getApprovedAnswer(label: string): Promise<string | null> {
  const row = await prisma.approvedAnswer.findFirst({
    where: { userId: null, questionText: normalizeQuestionText(label) },
  });
  return row?.answer ?? null;
}

export async function saveApprovedAnswer(label: string, answer: string): Promise<void> {
  const questionText = normalizeQuestionText(label);
  const existing = await prisma.approvedAnswer.findFirst({ where: { userId: null, questionText } });
  if (existing) {
    await prisma.approvedAnswer.update({ where: { id: existing.id }, data: { answer } });
    return;
  }
  await prisma.approvedAnswer.create({ data: { questionText, answer } });
}
