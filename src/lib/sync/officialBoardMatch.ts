import { listJobsForCompany, type CompanyForListing } from "@/lib/ats";
import type { AtsJob } from "@/lib/ats/types";
import { isAggregatorUrl } from "@/lib/applications/officialDestination";

export type DiscoveryJobIdentity = {
  title: string;
  location: string | null;
};

function normalizedText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(202[0-9]|summer|spring|fall|winter)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalizedText(value)
      .split(" ")
      .filter((token) => token.length > 1),
  );
}

function titleSimilarity(left: string, right: string): number {
  const a = normalizedText(left);
  const b = normalizedText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const at = tokenSet(a);
  const bt = tokenSet(b);
  if (at.size === 0 || bt.size === 0) return 0;
  let overlap = 0;
  for (const token of at) if (bt.has(token)) overlap += 1;
  return overlap / Math.max(at.size, bt.size);
}

function stateCode(location: string | null): string | null {
  if (!location) return null;
  const match = location.match(/(?:,|\s)\s*([A-Z]{2})(?:\b|$)/i);
  return match?.[1]?.toUpperCase() ?? null;
}

export function scoreOfficialBoardMatch(
  discovery: DiscoveryJobIdentity,
  official: Pick<AtsJob, "title" | "location" | "applyUrl">,
): number {
  if (!official.applyUrl || isAggregatorUrl(official.applyUrl)) return 0;

  const title = titleSimilarity(discovery.title, official.title);
  if (title < 0.55) return 0;

  const discoveryState = stateCode(discovery.location);
  const officialState = stateCode(official.location);
  if (discoveryState && officialState && discoveryState !== officialState) return 0;

  let score = title;
  if (discoveryState && officialState && discoveryState === officialState) score += 0.08;

  const discoveryLocation = normalizedText(discovery.location ?? "");
  const officialLocation = normalizedText(official.location ?? "");
  if (
    discoveryLocation &&
    officialLocation &&
    (discoveryLocation.includes(officialLocation) || officialLocation.includes(discoveryLocation))
  ) {
    score += 0.05;
  }

  return Math.min(1, score);
}

export async function findOfficialBoardMatch(
  discovery: DiscoveryJobIdentity,
  company: CompanyForListing,
): Promise<AtsJob | null> {
  if (!company.atsType || company.atsType === "unknown") return null;

  // Matching needs the board contents even when the normal company monitor saw
  // the same ETag earlier, so do not send conditional-cache state here.
  const result = await listJobsForCompany({
    ...company,
    lastETag: null,
    lastModified: null,
    contentHash: null,
  });
  if (!result.supported || result.jobs.length === 0) return null;

  let best: { job: AtsJob; score: number } | null = null;
  for (const job of result.jobs) {
    const score = scoreOfficialBoardMatch(discovery, job);
    if (!best || score > best.score) best = { job, score };
  }

  // Require a strong title match. Location can add confidence, but never rescue
  // a weak title, and a conflicting state rejects the match entirely.
  return best && best.score >= 0.72 ? best.job : null;
}
