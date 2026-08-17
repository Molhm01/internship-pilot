// Central Active-Jobs / Needs-Review policy.
//
// This is the SINGLE source of truth for two DISTINCT questions:
//
//   1. VISIBILITY  — should the job appear in the main Discover feed?
//   2. VERIFICATION — has the official employer destination been proven?
//
// Discover is now a DIRECT-SOURCE feed. Aggregators (Jobright / Simplify /
// Intern List) may still exist in the database as discovery/enrichment evidence,
// but they are not canonical jobs and never appear in the default feed.

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

// Aggregators are retained as secondary discovery/enrichment sources only.
export const TRUSTED_AGGREGATORS: ReadonlySet<CanonicalSource> = new Set<CanonicalSource>([
  "jobright",
  "simplify",
  "intern-list",
]);

// Sources where Internship Pilot now has a first-class adapter that reads a
// posting from the employer/public authority's own job system and validates the
// final job-detail destination. iCIMS and SuccessFactors enter this set only
// after the structured public-page adapters were added.
export const DIRECT_OFFICIAL_SOURCES: ReadonlySet<CanonicalSource> = new Set<CanonicalSource>([
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workday",
  "icims",
  "successfactors",
  "usajobs",
]);

// Startup/feed reconciliation predates the structured iCIMS/SuccessFactors
// adapters. Historical rows from those vendors may have been produced by the
// old generic HTML scanner, so they MUST NOT be bulk-promoted merely because
// the source token is now direct. They are promoted individually only when the
// new adapter rediscovers and verifies the exact official job URL.
export const LEGACY_AUTO_PROMOTABLE_DIRECT_SOURCES: ReadonlySet<CanonicalSource> = new Set<CanonicalSource>([
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workday",
  "usajobs",
]);

// Demo/fixture companies must never leak into the production Active feed.
export const DEMO_OR_FIXTURE_COMPANY =
  /(?:mock ats test|test documents co|test sync|fixture|demo company|gmail test co|test fixture co|test filter|test autoscore|test manual co|test broken co|test boundary co)/i;

/** Normalize any raw source/adapter value to one canonical token. */
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

export function isDirectOfficialSource(raw: string | null | undefined): boolean {
  const canonical = canonicalizeSource(raw);
  return canonical !== null && DIRECT_OFFICIAL_SOURCES.has(canonical);
}

export function isLegacyAutoPromotableDirectSource(raw: string | null | undefined): boolean {
  const canonical = canonicalizeSource(raw);
  return canonical !== null && LEGACY_AUTO_PROMOTABLE_DIRECT_SOURCES.has(canonical);
}

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
    case "CLOSED_OR_UNVERIFIED":
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
 * Default Discover feed policy.
 *
 * Third-party aggregator rows are intentionally hidden even if an old row was
 * previously verified. They remain in the database for deduplication and source
 * evidence, but the canonical visible catalogue comes from direct official
 * systems (or explicit manual entries).
 */
export function computeActiveFeed(job: ActiveFeedInput): boolean {
  const state = verificationStateOf(job.verificationStatus);
  const source = canonicalizeSource(job.source);

  if (DEMO_OR_FIXTURE_COMPANY.test(job.company)) return false;

  // Jobright/Simplify/Intern-List are secondary evidence, never canonical feed rows.
  if (source !== null && TRUSTED_AGGREGATORS.has(source)) return false;

  if (state === "quarantined" || state === "destination_unavailable" || state === "destination_mismatch") {
    return false;
  }

  // A direct/officially verified destination is visible.
  if (state === "official_destination_verified") return true;

  // Manual entries are trusted by construction.
  if (source === "manual") return true;

  // Unknown, generic, and pending non-aggregator rows stay hidden until proven.
  return false;
}
