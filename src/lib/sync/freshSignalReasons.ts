// Why a fresh discovery signal did not become a visible, officially-resolved
// internship.
//
// The rule this module exists to enforce: there is NO generic "unresolved"
// bucket. Every signal the fresh radar cannot promote carries one of these
// codes, so "47 signals, 0 resolved" can never again be reported without also
// saying which of these eleven things went wrong, and how often.

export const FRESH_SIGNAL_REASONS = [
  /** The feed row carried no employer-side URL at all (only an aggregator link). */
  "NO_OFFICIAL_URL",
  /** No employer identity could be established — no known company, no source-published domain. */
  "UNKNOWN_COMPANY",
  /** The employer is identified, but no ATS/board could be discovered for it. */
  "NO_ATS_CONFIG",
  /** An ATS/board is known, but fetching it failed or it returned nothing. */
  "ATS_BOARD_FETCH_FAILED",
  /** The board was read successfully and contains no plausible counterpart. */
  "NO_BOARD_MATCH",
  /** A counterpart exists but the title similarity stayed under the accept bar. */
  "TITLE_MATCH_TOO_LOW",
  /** Title matched but the states/locations conflict — a different posting. */
  "LOCATION_MISMATCH",
  /** A candidate destination was found but is not a valid official application URL. */
  "OFFICIAL_URL_REJECTED",
  /** The official posting exists and says it is closed/filled/expired/removed. */
  "POSTING_CLOSED",
  /** A transient network/HTTP failure. Explicitly NOT a closure. */
  "NETWORK_FAILURE",
  /** The board answered 429 / 5xx. Transient by definition — back off, retry. */
  "RATE_LIMITED",
  /**
   * The board served a bot wall instead of its public listing (iCIMS answers
   * automated GETs with HTTP 405 "Human Verification"). Distinct from a fetch
   * failure because the remedy is different: render the public page once,
   * rather than simply asking again.
   */
  "BOT_WALL_BLOCKED",
  /** The signal itself could not be parsed into a usable identity. */
  "PARSER_FAILURE",
] as const;

export type FreshSignalReason = (typeof FRESH_SIGNAL_REASONS)[number];

export type FreshSignalReasonCounts = Partial<Record<FreshSignalReason, number>>;

/**
 * Reasons that describe a temporary condition rather than a verdict about the
 * posting. These are retried sooner and never treated as evidence that a job
 * is gone.
 */
const TRANSIENT: ReadonlySet<FreshSignalReason> = new Set<FreshSignalReason>([
  "ATS_BOARD_FETCH_FAILED",
  "NETWORK_FAILURE",
  "RATE_LIMITED",
  "BOT_WALL_BLOCKED",
]);

export function isTransientReason(reason: FreshSignalReason): boolean {
  return TRANSIENT.has(reason);
}

const ONE_MINUTE_MS = 60_000;

/**
 * Retry backoff for one unresolved signal.
 *
 * Transient failures come back quickly. Structural ones (no board exists for
 * this employer) back off hard so a five-minute radar does not spend its whole
 * budget re-failing the same employer, but they never stop entirely — an
 * employer can publish a careers page tomorrow.
 */
export function nextAttemptDelayMs(reason: FreshSignalReason, attempts: number): number {
  const base = isTransientReason(reason) ? 5 : 60;
  const capMinutes = isTransientReason(reason) ? 60 : 24 * 60;
  const minutes = Math.min(capMinutes, base * 2 ** Math.max(0, attempts - 1));
  return minutes * ONE_MINUTE_MS;
}

export function emptyReasonCounts(): FreshSignalReasonCounts {
  return {};
}

export function countReason(
  counts: FreshSignalReasonCounts,
  reason: FreshSignalReason,
): FreshSignalReasonCounts {
  counts[reason] = (counts[reason] ?? 0) + 1;
  return counts;
}

/** Stable "REASON=n" rendering for logs and diagnostics, busiest reason first. */
export function formatReasonCounts(counts: FreshSignalReasonCounts): string {
  const entries = Object.entries(counts).filter(([, value]) => (value ?? 0) > 0);
  if (entries.length === 0) return "none";
  return entries
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      (rightValue ?? 0) - (leftValue ?? 0) || leftKey.localeCompare(rightKey),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

/**
 * Company identity key shared by every part of the fresh pipeline.
 *
 * Legal-form suffixes and punctuation are dropped so "Hubbell Incorporated",
 * "Hubbell Inc." and "Hubbell" are one employer, while "Procter & Gamble"
 * normalizes through "and" rather than losing the conjunction entirely.
 */
export function normalizeCompanyKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(
      /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|company|co|holdings|group|plc|gmbh|sa|nv|ag|kk|pte|pvt)\b/g,
      " ",
    )
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}
