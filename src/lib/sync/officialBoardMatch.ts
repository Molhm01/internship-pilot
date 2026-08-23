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
    // Feeds routinely carry the employer's page <title> rather than the job
    // title — "Controls Engineering Summer 2027 Internship (Bettendorf, IA)
    // Job Details | Lincoln Electric". The site-name suffix and the "job
    // details" boilerplate are about the page, not the role, and leaving them
    // in drags the similarity of a perfect match below the accept bar.
    .replace(/\s*\|.*$/, " ")
    .replace(/\bjob details\b/g, " ")
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

/** The accept bar for treating a board posting as the same job as a signal. */
export const OFFICIAL_BOARD_MATCH_THRESHOLD = 0.72;

export type BoardMatchRejection =
  | "OFFICIAL_URL_REJECTED"
  | "TITLE_MATCH_TOO_LOW"
  | "LOCATION_MISMATCH";

export type BoardMatchVerdict =
  | { accepted: true; job: AtsJob; score: number }
  | {
      accepted: false;
      reason: BoardMatchRejection | "NO_BOARD_MATCH";
      /** Best combined match score. Zero whenever a hard gate rejected everything. */
      bestScore: number;
      /**
       * Best RAW title similarity on the board, independent of the gates. This
       * is the number that tells a human whether the counterpart was there at
       * all — bestScore alone reads 0.00 for "no such job" and for "same job,
       * wrong state" alike.
       */
      bestTitleSimilarity: number;
      /** Title of the closest posting by raw similarity, for eyeballing. */
      closestTitle: string | null;
    };

/**
 * Pick the best counterpart on a board AND say why nothing was accepted.
 *
 * scoreOfficialBoardMatch collapses every failure to 0, which is what produced
 * a single undifferentiated "unresolved" bucket. This keeps the same accept
 * decision but reports the most specific reason available, so diagnostics can
 * distinguish "the board had nothing like this" from "the title matched but the
 * states disagree" from "the board's own link is not an official apply URL".
 */
export function classifyOfficialBoardMatch(
  discovery: DiscoveryJobIdentity,
  jobs: AtsJob[],
): BoardMatchVerdict {
  if (jobs.length === 0) {
    return {
      accepted: false,
      reason: "NO_BOARD_MATCH",
      bestScore: 0,
      bestTitleSimilarity: 0,
      closestTitle: null,
    };
  }

  let best: { job: AtsJob; score: number } | null = null;
  let closest: { title: string; similarity: number } | null = null;
  let sawTitleCandidate = false;
  let sawLocationConflict = false;
  let sawRejectedUrl = false;

  for (const job of jobs) {
    const score = scoreOfficialBoardMatch(discovery, job);
    if (!best || score > best.score) best = { job, score };
    const similarity = titleSimilarity(discovery.title, job.title);
    if (!closest || similarity > closest.similarity) closest = { title: job.title, similarity };
    if (score > 0) continue;

    // score === 0: work out which gate closed. Only postings whose TITLE is
    // already a plausible counterpart are diagnosed further — a board of 500
    // unrelated roles must read as "nothing like this here", not as a URL or
    // location problem.
    if (similarity < 0.55) continue;
    sawTitleCandidate = true;
    if (!job.applyUrl || isAggregatorUrl(job.applyUrl)) {
      sawRejectedUrl = true;
      continue;
    }
    sawLocationConflict = true;
  }

  if (best && best.score >= OFFICIAL_BOARD_MATCH_THRESHOLD) {
    return { accepted: true, job: best.job, score: best.score };
  }

  const context = {
    bestScore: best?.score ?? 0,
    bestTitleSimilarity: closest?.similarity ?? 0,
    closestTitle: closest?.title ?? null,
  };
  const rejected = (reason: BoardMatchRejection | "NO_BOARD_MATCH"): BoardMatchVerdict => ({
    accepted: false,
    reason,
    ...context,
  });

  // A near-miss on score is the most actionable signal, so it outranks the
  // hard-gate diagnoses below it.
  if (context.bestScore > 0) return rejected("TITLE_MATCH_TOO_LOW");
  if (sawLocationConflict) return rejected("LOCATION_MISMATCH");
  if (sawRejectedUrl) return rejected("OFFICIAL_URL_REJECTED");
  if (sawTitleCandidate) return rejected("TITLE_MATCH_TOO_LOW");
  return rejected("NO_BOARD_MATCH");
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
