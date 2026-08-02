// Central Active-Jobs / Needs-Review policy.
//
// This is the SINGLE source of truth for two DISTINCT questions that used to
// be conflated into one `verificationStatus` field:
//
//   1. VISIBILITY  — should the job appear in the main "Active Jobs" feed?
//   2. VERIFICATION — has the official employer destination been proven?
//
// A listing from a trusted discovery aggregator (Jobright / Simplify /
// Intern List) is allowed into Active Jobs even when its official destination
// has not yet been independently verified. Making a job visible NEVER changes
// its verification state — the two are reported separately.

export type CanonicalSource =
  | "jobright"
  | "simplify"
  | "intern-list"
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "workday"
  | "icims"
  | "taleo"
  | "successfactors"
  | "usajobs"
  | "manual"
  | "other";

// The three aggregators whose listings are trusted enough to appear in the
// Active feed prior to official-destination verification.
export const TRUSTED_AGGREGATORS: ReadonlySet<CanonicalSource> = new Set<CanonicalSource>([
  "jobright",
  "simplify",
  "intern-list",
]);

// Demo/fixture companies must never leak into the production Active feed.
// (Kept in sync with the Needs-Review audit's exclusion.)
export const DEMO_OR_FIXTURE_COMPANY =
  /(?:mock ats test|test documents co|test sync|fixture|demo company|gmail test co|test fixture co|test filter|test autoscore|test manual co|test broken co|test boundary co)/i;

/**
 * Normalize any raw source/adapter value — regardless of capitalization,
 * punctuation, URL formatting, `ats:` prefixing, or vendor suffix words like
 * "ai"/"jobs"/"inc" — to a single canonical token.
 *
 * Examples that all resolve to "jobright":
 *   "jobright", "jobright.ai", "Jobright AI", "https://jobright.ai/...", "jobright-ai"
 * All resolve to "simplify":  "simplify", "simplify.jobs", "Simplify AI", "simplify-jobs"
 * All resolve to "intern-list": "intern-list", "intern-list.com", "Intern List", "internlist"
 */
export function canonicalizeSource(raw: string | null | undefined): CanonicalSource | null {
  if (raw === null || raw === undefined) return null;
  let value = String(raw).trim().toLowerCase();
  if (!value) return null;

  // Strip a leading adapter prefix ("ats:greenhouse" -> "greenhouse").
  value = value.replace(/^ats:/, "");

  // If it looks like a URL, reduce it to its hostname.
  const urlMatch = value.match(/^[a-z]+:\/\/([^/]+)/);
  if (urlMatch) value = urlMatch[1];
  value = value.replace(/^www\./, "");

  // Collapse everything non-alphanumeric so "intern list", "intern-list",
  // "intern_list", "intern.list", "internlist" all compare equal, and drop
  // common vendor suffix noise words.
  const collapsed = value
    .replace(/\.(com|ai|io|co|net|org|jobs)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(ai|inc|llc|jobs|labs|the|app)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const flat = collapsed.replace(/\s+/g, "");

  if (/jobright/.test(flat)) return "jobright";
  if (/simplify/.test(flat)) return "simplify";
  if (/internlist/.test(flat)) return "intern-list";
  if (/greenhouse/.test(flat)) return "greenhouse";
  if (/lever/.test(flat)) return "lever";
  if (/ashby/.test(flat)) return "ashby";
  if (/smartrecruiters/.test(flat)) return "smartrecruiters";
  if (/workday/.test(flat)) return "workday";
  if (/icims/.test(flat)) return "icims";
  if (/taleo/.test(flat)) return "taleo";
  if (/successfactors/.test(flat)) return "successfactors";
  if (/usajobs/.test(flat)) return "usajobs";
  if (/manual/.test(flat)) return "manual";
  return "other";
}

export function isTrustedAggregatorSource(raw: string | null | undefined): boolean {
  const canonical = canonicalizeSource(raw);
  return canonical !== null && TRUSTED_AGGREGATORS.has(canonical);
}

// The verification sub-states requested by the source-security policy,
// derived from the existing `verificationStatus` values (schema preserved).
export type VerificationState =
  | "official_destination_verified"
  | "source_listed"
  | "verification_pending"
  | "destination_unavailable"
  | "destination_mismatch"
  | "quarantined"
  | "unverified";

export function verificationStateOf(verificationStatus: string): VerificationState {
  switch (verificationStatus) {
    case "VERIFIED_OFFICIAL_AT_LAST_CHECK":
      return "official_destination_verified";
    case "ACTIVE_SOURCE_LISTED":
      return "source_listed";
    case "VERIFICATION_PENDING":
    case "Pending":
    case "NeedsReview":
    case "CLOSED_OR_UNVERIFIED": // legacy false-closure state; not actually closed
      return "verification_pending";
    case "Closed":
      return "destination_unavailable";
    case "DESTINATION_MISMATCH":
      return "destination_mismatch";
    case "SecurityQuarantine":
      return "quarantined";
    default:
      return "unverified";
  }
}

export type ActiveFeedInput = {
  source: string | null;
  verificationStatus: string;
  company: string;
};

/**
 * The one policy function. Returns true when a job belongs in the Active
 * Jobs feed. Never mutates or considers anything except the three inputs, so
 * it is safe to call from every write path and from tests.
 */
export function computeActiveFeed(job: ActiveFeedInput): boolean {
  const state = verificationStateOf(job.verificationStatus);

  // Demo/fixture rows never leak into the production feed.
  if (DEMO_OR_FIXTURE_COMPANY.test(job.company)) return false;

  // The three states that are never in the default active feed: security
  // blocked, confirmed closed, and a confirmed destination mismatch. Every
  // other state is presented as active (a missing ATS mirror is NOT closed).
  if (state === "quarantined" || state === "destination_unavailable" || state === "destination_mismatch") {
    return false;
  }

  // An officially-verified destination is always active, whatever its source.
  if (state === "official_destination_verified") return true;

  // Source-listed / verification-pending listings from a trusted aggregator
  // (Jobright / Simplify / Intern List) or a manual entry are active. Manual
  // entries are trusted by construction.
  if (isTrustedAggregatorSource(job.source) || canonicalizeSource(job.source) === "manual") {
    return true;
  }

  // Everything else (unknown/untrusted sources) stays hidden until it is
  // independently verified.
  return false;
}
