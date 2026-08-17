import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";

export type FingerprintFact = {
  id: string;
  type: string;
  content: string;
  detail: string | null;
};

export type ApprovedProfileRevision = {
  hash: string;
  factCount: number;
};

/** Stable hash of exactly the approved résumé facts AI Match is allowed to use. */
export function fingerprintApprovedFacts(facts: FingerprintFact[]): string {
  const canonical = [...facts]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((fact) => ({
      id: fact.id,
      type: fact.type,
      content: fact.content.trim(),
      detail: fact.detail?.trim() ?? null,
    }));

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export async function approvedProfileRevision(
  userId: string,
): Promise<ApprovedProfileRevision | null> {
  const facts = await prisma.resumeFact.findMany({
    where: { userId, status: { in: ["approved", "edited"] } },
    orderBy: { id: "asc" },
    select: { id: true, type: true, content: true, detail: true },
  });
  if (facts.length === 0) return null;
  return { hash: fingerprintApprovedFacts(facts), factCount: facts.length };
}

export function scoreOriginForProfile(
  kind: "MANUAL" | "INITIAL_AUTO" | "PROFILE_AUTO",
  profileHash: string,
): `${typeof kind}:${string}` {
  return `${kind}:${profileHash}`;
}

export function originMatchesProfile(
  origin: string | null | undefined,
  profileHash: string,
): boolean {
  if (!origin) return false;
  return origin.endsWith(`:${profileHash}`);
}
