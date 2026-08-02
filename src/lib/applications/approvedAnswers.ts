import { prisma } from "@/lib/db";

export function normalizeQuestionText(label: string): string {
  return label.toLowerCase().replace(/\*/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

// Reuse is intentionally scoped to generic/unclassified questions only
// (see formFiller.ts) — never for work-authorization/sponsorship/clearance/
// EEO categories, which always re-ask unless the user has set a profile
// field explicitly. This is for things like repeated "Why this company?"
// or employer-specific screening questions across applications.
export async function getApprovedAnswer(label: string): Promise<string | null> {
  const row = await prisma.approvedAnswer.findUnique({ where: { questionText: normalizeQuestionText(label) } });
  return row?.answer ?? null;
}

export async function saveApprovedAnswer(label: string, answer: string): Promise<void> {
  const questionText = normalizeQuestionText(label);
  await prisma.approvedAnswer.upsert({
    where: { questionText },
    update: { answer },
    create: { questionText, answer },
  });
}
