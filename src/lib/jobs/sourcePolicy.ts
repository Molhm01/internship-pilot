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
  | "linkedin"
  | "indeed"
  | "handshake"
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "workday"
  | "icims"
  | "taleo"
  | "successfactors"
  | "eightfold"
  | "phenom"
  | "usajobs"
  | "manual"
  | "other";

// Aggregators are retained as secondary discovery/enrichment sources only.
export const TRUSTED_AGGREGATORS: ReadonlySet<CanonicalSource> = new Set<CanonicalSource>([
  "jobright",
  "simplify",
  "intern-list",
]);

// Live high-velocity internship job boards where postings open hours before
// static curated lists update. When an official employer ATS URL is resolved,
// rows are ingested under that ATS; when listed natively on the live board,
// they remain visible when official_destination_verified or source_listed.
export const LIVE_JOB_BOARD_SOURCES: ReadonlySet<CanonicalSource> = new Set<CanonicalSource>([
  "linkedin",
  "indeed",
  "handshake",
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
  // Eightfold and Phenom are career-site layers in front of a real ATS. A
  // posting read from their public JSON API is the employer's own record, and
  // Phenom rows even carry the underlying ATS apply URL directly.
  "eightfold",
  "phenom",
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
  if (/linkedin/.test(flat)) return "linkedin";
  if (/indeed/.test(flat)) return "indeed";
  if (/handshake/.test(flat)) return "handshake";
  if (/greenhouse/.test(flat)) return "greenhouse";
  if (/lever/.test(flat)) return "lever";
  if (/ashby/.test(flat)) return "ashby";
  if (/smartrecruiters/.test(flat)) return "smartrecruiters";
  if (/workday/.test(flat)) return "workday";
  if (/icims/.test(flat)) return "icims";
  if (/taleo/.test(flat)) return "taleo";
  if (/successfactors/.test(flat)) return "successfactors";
  if (/eightfold/.test(flat)) return "eightfold";
  if (/phenom/.test(flat)) return "phenom";
  if (/usajobs/.test(flat)) return "usajobs";
  if (/manual/.test(flat)) return "manual";
  return "other";
}

export function isTrustedAggregatorSource(raw: string | null | undefined): boolean {
  const canonical = canonicalizeSource(raw);
  return canonical !== null && TRUSTED_AGGREGATORS.has(canonical);
}

export function isLiveJobBoardSource(raw: string | null | undefined): boolean {
  const canonical = canonicalizeSource(raw);
  return canonical !== null && LIVE_JOB_BOARD_SOURCES.has(canonical);
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

export const MAX_ACTIVE_FEED_AGE_DAYS = 7;
export const MAX_UNDATED_ACTIVE_AGE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isWithinActiveFreshnessWindow(
  input: {
    sourcePostedAt?: Date | string | null;
    createdAt?: Date | string | null;
    source?: string | null;
  },
  maxAgeDays = MAX_ACTIVE_FEED_AGE_DAYS,
  now = new Date(),
): boolean {
  const source = canonicalizeSource(input.source);
  if (source === "manual") return true;

  // Preserve test/caller invocations that intentionally evaluate source/verification policy without dates.
  if (input.sourcePostedAt === undefined && input.createdAt === undefined) {
    return true;
  }

  const nowMs = now.getTime();
  if (input.sourcePostedAt != null) {
    const postedMs =
      input.sourcePostedAt instanceof Date
        ? input.sourcePostedAt.getTime()
        : new Date(input.sourcePostedAt).getTime();
    if (Number.isFinite(postedMs)) {
      return nowMs - postedMs <= maxAgeDays * DAY_MS;
    }
  }

  if (input.createdAt != null) {
    const createdMs =
      input.createdAt instanceof Date
        ? input.createdAt.getTime()
        : new Date(input.createdAt).getTime();
    if (Number.isFinite(createdMs)) {
      return nowMs - createdMs <= MAX_UNDATED_ACTIVE_AGE_DAYS * DAY_MS;
    }
  }

  return true;
}

export type ActiveFeedInput = {
  source: string | null;
  verificationStatus: string;
  company: string;
  sourcePostedAt?: Date | string | null;
  createdAt?: Date | string | null;
  now?: Date;
};

/**
 * Default Discover feed policy.
 *
 * Third-party aggregator rows are intentionally hidden even if an old row was
 * previously verified. They remain in the database for deduplication and source
 * evidence, but the canonical visible catalogue comes from direct official
 * systems, live job board crawls (LinkedIn/Indeed/Handshake), or explicit manual entries.
 * Weeks-old postings outside the active freshness window are excluded.
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

  if (!isWithinActiveFreshnessWindow(job, MAX_ACTIVE_FEED_AGE_DAYS, job.now)) {
    return false;
  }

  // A direct/officially verified destination is visible.
  if (state === "official_destination_verified") return true;

  // Live job board sightings (LinkedIn / Indeed / Handshake) are visible immediately
  // while destination resolution completes or when natively hosted on the board.
  if (source !== null && LIVE_JOB_BOARD_SOURCES.has(source) && state === "source_listed") {
    return true;
  }

  // Manual entries are trusted by construction.
  if (source === "manual") return true;

  // Unknown, generic, and pending non-aggregator rows stay hidden until proven.
  return false;
}
