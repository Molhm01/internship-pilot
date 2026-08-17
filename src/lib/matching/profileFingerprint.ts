import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";

export const PROFILE_REFRESH_MATCH_PREFIX = "PROFILE_REFRESH:";

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
): string {
  return `${kind}:${profileHash}`;
}

export function originMatchesProfile(
  origin: string | null | undefined,
  profileHash: string,
): boolean {
  if (!origin) return false;
  return origin.endsWith(`:${profileHash}`);
}

export function profileRefreshMatchType(profileHash: string): string {
  return `${PROFILE_REFRESH_MATCH_PREFIX}${profileHash}`;
}

export function profileHashFromRefreshMatchType(matchType: string): string | null {
  if (!matchType.startsWith(PROFILE_REFRESH_MATCH_PREFIX)) return null;
  const hash = matchType.slice(PROFILE_REFRESH_MATCH_PREFIX.length);
  return /^[a-f0-9]{64}$/i.test(hash) ? hash : null;
}
