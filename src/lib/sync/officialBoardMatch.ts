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
    // "Internship" and "Intern" are the same word for matching purposes, and
    // so are every spelling of co-op. Treating them as distinct tokens made
    // "Structural Engineering Internship" and "Structural Engineering Intern"
    // share only their non-role words and fall under the accept bar.
    .replace(/\binternships?\b/g, "intern")
    .replace(/\bco[-\s]?ops?\b/g, "coop")
    .replace(/\b(202[0-9]|summer|spring|fall|winter)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(stemToken)
    .join(" ")
    .trim();
}

/**
 * Collapse the word forms boards and feeds use for the same thing.
 *
 * A live miss made the case: Infineon's own Eightfold board carried
 * "Intern - Product Engineering" while the radar signal said
 * "Intern- Product Engineer". Three tokens each, two shared, similarity 0.67 —
 * under the 0.72 accept bar, so the employer's own posting for the employer's
 * own job was rejected. "Engineer" and "engineering" are the same discipline.
 *
 * Deliberately a short explicit table plus a conservative plural rule, not a
 * real stemmer: an aggressive stemmer collapses genuinely different
 * disciplines, and a wrong match is worse here than a missed one.
 */
const EQUIVALENT_FORMS: Record<string, string> = {
  engineering: "engineer",
  engineers: "engineer",
  sciences: "science",
  scientists: "scientist",
  analytics: "analytic",
  operations: "operation",
  systems: "system",
  technologies: "technology",
  solutions: "solution",
  developers: "developer",
  development: "developer",
  applications: "application",
  communications: "communication",
};

function stemToken(token: string): string {
  const mapped = EQUIVALENT_FORMS[token];
  if (mapped) return mapped;
  // Plain plurals only, and only on words long enough that the final "s" is
  // not carrying the meaning ("ops", "sys", "eos").
  if (token.length >= 6 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalizedText(value)
      .split(" ")
      .filter((token) => token.length > 1),
  );
}

/**
 * Tokens that say "this is an internship" rather than "this is which job".
 *
 * They carry no discriminating power — every candidate on both sides has them —
 * but they must still AGREE: an internship may never match a full-time role.
 */
const ROLE_KIND_TOKENS = new Set(["intern", "interns", "internship", "internships", "coop", "co"]);

function isInternshipTitle(tokens: Set<string>): boolean {
  for (const token of tokens) if (ROLE_KIND_TOKENS.has(token)) return true;
  return false;
}

/**
 * Words that say WHICH engineering discipline a role is.
 *
 * These are the discriminating token in almost every internship title, and
 * they are exactly the token a bag-of-words similarity discounts: "Electrical
 * Engineering Intern" and "Mechanical Engineering Intern" share two of three
 * tokens, score 0.67, and then the same-state and location-containment bonuses
 * carry the pair to 0.80 — over the 0.72 bar. That is a wrong employer posting
 * published under a real signal, which is the one outcome this pipeline treats
 * as worse than a miss.
 *
 * So disciplines are a hard gate, like internship-vs-full-time: if both titles
 * name a discipline and they name different ones, they are different jobs and
 * no amount of location agreement may say otherwise.
 */
const DISCIPLINE_TOKENS = new Set([
  "electrical", "mechanical", "civil", "chemical", "structural", "industrial",
  "aerospace", "biomedical", "environmental", "nuclear", "optical", "materials",
  "material", "petroleum", "geotechnical", "metallurgical", "acoustic",
  "software", "hardware", "firmware", "embedded", "mechatronic", "mechatronics",
  "robotic", "robotics", "photonic", "photonics", "rf", "analog", "digital",
  "asic", "fpga", "rtl", "silicon", "semiconductor",
  "manufacturing", "quality", "process", "controls", "control", "power",
  "thermal", "structural", "systems", "system", "network", "security",
  "data", "ml", "ai", "geological", "mining", "marine", "naval", "agricultural",
]);

function disciplineTokens(tokens: Set<string>): Set<string> {
  const found = new Set<string>();
  for (const token of tokens) if (DISCIPLINE_TOKENS.has(token)) found.add(token);
  return found;
}

function titleSimilarity(left: string, right: string): number {
  const a = normalizedText(left);
  const b = normalizedText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const at = tokenSet(a);
  const bt = tokenSet(b);
  if (at.size === 0 || bt.size === 0) return 0;

  // An internship and a full-time role of the same name are different jobs.
  // This is a hard gate, never a score adjustment.
  if (isInternshipTitle(at) !== isInternshipTitle(bt)) return 0;

  // Neither are two different disciplines. Also a hard gate: a location bonus
  // must never be able to carry "Electrical …" onto "Mechanical …".
  const ad = disciplineTokens(at);
  const bd = disciplineTokens(bt);
  if (ad.size > 0 && bd.size > 0) {
    let sharesDiscipline = false;
    for (const token of ad) if (bd.has(token)) sharesDiscipline = true;
    if (!sharesDiscipline) return 0;
  }

  let overlap = 0;
  for (const token of at) if (bt.has(token)) overlap += 1;
  const base = overlap / Math.max(at.size, bt.size);

  // Boards routinely append team, location or programme qualifiers that a feed
  // omits: "Structural Engineering Intern - Bridge Group - Chicago" against
  // "Structural Engineering Internship". Dividing by the LONGER title punishes
  // that, so a fully-contained title earns a bounded lift.
  //
  // Guarded deliberately: the contained title must carry at least three
  // meaningful tokens beyond the internship marker, so "Software Intern" cannot
  // absorb "Software Intern Program Manager". And the lift can reach the accept
  // bar but never exceed a genuine near-exact match.
  const shorter = at.size <= bt.size ? at : bt;
  const longer = at.size <= bt.size ? bt : at;
  const contained = overlap === shorter.size;
  const distinctiveTokens = [...shorter].filter((token) => !ROLE_KIND_TOKENS.has(token)).length;
  if (contained && distinctiveTokens >= 3) {
    const containment = shorter.size / longer.size;
    return Math.min(0.95, Math.max(base, 0.55 + 0.4 * containment));
  }

  return base;
}

const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA",
  "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT",
  "VA", "WA", "WV", "WI", "WY", "DC", "PR", "VI", "GU",
]);

const US_STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
  michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY", "district of columbia": "DC", "puerto rico": "PR",
};

/**
 * The US state a location string refers to, as a two-letter code.
 *
 * Two things this must get right, both learned from real mismatches:
 *
 *  - The abbreviation match is CASE-SENSITIVE and checked against the actual
 *    list of state codes. A case-insensitive `[A-Z]{2}` happily read
 *    "Mason, Ohio, United States of America" as the state "OF", which then
 *    conflicted with the signal's "OH" and rejected an exact-title match on the
 *    employer's own board.
 *  - Boards and feeds disagree on format. One writes "Cincinnati, OH", the
 *    other "Mason, Ohio, United States of America". Spelled-out state names are
 *    resolved to the same code so the two can be compared at all.
 */
export function stateCode(location: string | null): string | null {
  return stateCodes(location)[0] ?? null;
}

/**
 * EVERY US state a location string refers to.
 *
 * Multi-site postings are ordinary — "Austin, TX; San Jose, CA", "Phoenix,
 * Arizona or Hillsboro, Oregon" — and reading only the first state turned a
 * correct counterpart into a LOCATION_MISMATCH whenever the two sides happened
 * to list the same sites in a different order. Comparing sets fixes that
 * without weakening the gate: a genuine conflict is still a conflict, because
 * conflict means the two sets share nothing.
 */
export function stateCodes(location: string | null): string[] {
  if (!location) return [];
  const found: string[] = [];

  // A bare two-letter token is only a state when it sits where a state sits:
  // after the comma or separator that follows a city, or as the whole string.
  // Without that context "Data Engineering Intern OR Student Co-Op" yields
  // Oregon and "ME Intern" yields Maine — the same class of mistake as reading
  // "United States of America" as the state "OF", which this file already
  // learned once.
  const wholeString = location.trim();
  if (US_STATE_CODES.has(wholeString)) found.push(wholeString);

  for (const match of location.matchAll(/[,/|]\s*([A-Z]{2})(?![A-Za-z])/g)) {
    const code = match[1]!;
    if (US_STATE_CODES.has(code) && !found.includes(code)) found.push(code);
  }
  // "US-VA-STERLING" and "USA-TX" style codes boards emit in their own paths.
  for (const match of location.matchAll(/\bUS[A]?[-_]([A-Z]{2})(?![A-Za-z])/g)) {
    const code = match[1]!;
    if (US_STATE_CODES.has(code) && !found.includes(code)) found.push(code);
  }

  const lower = location.toLowerCase();
  for (const [name, code] of Object.entries(US_STATE_NAMES)) {
    if (new RegExp(`(?:^|[,(/\\s])${name}(?:[,)/\\s]|$)`).test(lower) && !found.includes(code)) {
      found.push(code);
    }
  }
  return found;
}

/**
 * Do two location strings contradict each other?
 *
 * Only when both name US states and none of them coincide. "Remote", "United
 * States" and an unparseable string all mean "no evidence", which is never a
 * contradiction — the title and company evidence decides those.
 */
export function locationsConflict(left: string | null, right: string | null): boolean {
  const a = stateCodes(left);
  const b = stateCodes(right);
  if (a.length === 0 || b.length === 0) return false;
  return !a.some((code) => b.includes(code));
}

export function scoreOfficialBoardMatch(
  discovery: DiscoveryJobIdentity,
  official: Pick<AtsJob, "title" | "location" | "applyUrl">,
): number {
  if (!official.applyUrl || isAggregatorUrl(official.applyUrl)) return 0;

  const title = titleSimilarity(discovery.title, official.title);
  if (title < 0.55) return 0;

  if (locationsConflict(discovery.location, official.location)) return 0;

  const discoveryStates = stateCodes(discovery.location);
  const officialStates = stateCodes(official.location);
  const sharesState =
    discoveryStates.length > 0 && officialStates.some((code) => discoveryStates.includes(code));

  let score = title;
  if (sharesState) score += 0.08;

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
