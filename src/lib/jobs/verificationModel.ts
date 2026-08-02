// Canonical job-availability verification model.
//
// This replaces the old policy that treated "no Greenhouse/Lever/Ashby mirror
// found" as POSTING_CLOSED. Greenhouse/Lever/Ashby are only three of many
// legitimate ATS providers (Workday, iCIMS, SmartRecruiters, SuccessFactors,
// Taleo, Jobvite, UKG, ADP, Oracle, Eightfold, custom career pages, ...), so a
// missing mirror is NOT evidence of closure. It only means the official
// destination has not been independently confirmed yet.
//
// Two DISTINCT axes are reported separately (never conflated):
//   1. AVAILABILITY  — is the posting active, pending, closed, mismatched, blocked?
//   2. OFFICIAL VERIFICATION — has the official employer destination been proven?
//
// The AVAILABILITY value is stored in Job.verificationStatus. The historical
// literal "VERIFIED_OFFICIAL_AT_LAST_CHECK" is kept as the "official
// destination verified" value (an active state whose destination is proven).

// ---- Availability states (stored in Job.verificationStatus) --------------

export const AVAILABILITY = {
  // Destination loads and still presents a job/apply/form; the official
  // employer destination was independently confirmed.
  OFFICIAL_VERIFIED: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
  // Present in a trusted discovery source; official destination not yet
  // conclusively verified. Active and applyable.
  ACTIVE_SOURCE_LISTED: "ACTIVE_SOURCE_LISTED",
  // A transient network/parse/redirect failure prevented verification. Stays
  // visible; never presented as closed.
  VERIFICATION_PENDING: "VERIFICATION_PENDING",
  // The destination explicitly says closed/expired/removed or returns a
  // genuine 404/410. The ONLY state presented as closed.
  CLOSED_CONFIRMED: "Closed",
  // Final destination clearly has a different company/title/job id.
  DESTINATION_MISMATCH: "DESTINATION_MISMATCH",
  // Destination appears fraudulent/malicious or violates the safety policy.
  SECURITY_BLOCKED: "SecurityQuarantine",
} as const;

export type Availability = (typeof AVAILABILITY)[keyof typeof AVAILABILITY];

// Legacy statuses map into the canonical set so old rows read correctly even
// before the repair migration runs.
export function canonicalAvailability(status: string | null | undefined): Availability {
  switch (status) {
    case "VERIFIED_OFFICIAL_AT_LAST_CHECK":
      return AVAILABILITY.OFFICIAL_VERIFIED;
    case "ACTIVE_SOURCE_LISTED":
      return AVAILABILITY.ACTIVE_SOURCE_LISTED;
    case "VERIFICATION_PENDING":
    case "Pending":
    case "NeedsReview":
      return AVAILABILITY.VERIFICATION_PENDING;
    case "Closed":
      return AVAILABILITY.CLOSED_CONFIRMED;
    case "DESTINATION_MISMATCH":
      return AVAILABILITY.DESTINATION_MISMATCH;
    case "SecurityQuarantine":
      return AVAILABILITY.SECURITY_BLOCKED;
    // "CLOSED_OR_UNVERIFIED" was the old false-closure state — a missing ATS
    // mirror is NOT closed. Treat legacy rows as source-listed until repaired.
    case "CLOSED_OR_UNVERIFIED":
      return AVAILABILITY.ACTIVE_SOURCE_LISTED;
    default:
      return AVAILABILITY.ACTIVE_SOURCE_LISTED;
  }
}

// ---- Reason codes (stored in Job.reasonCode) -----------------------------
// Exactly ONE code per current state. Never concatenated.

export const REASON_CODES = [
  "OFFICIAL_VERIFIED",
  "SOURCE_LISTED",
  "OFFICIAL_MIRROR_NOT_FOUND",
  "DESTINATION_LOCATION_DISCREPANCY",
  "DESTINATION_ROLE_DISCREPANCY",
  "REDIRECT_SUSPICIOUS",
  "DESTINATION_MISMATCH",
  "CLOSED_NOT_FOUND",
  "CLOSED_EXPIRED",
  "NETWORK_FAILURE",
  "PARSING_FAILURE",
  "SECURITY_BLOCKED",
  "MANUAL_ENTRY",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

// ---- Display badges (main Jobs feed) -------------------------------------

export type BadgeKind =
  | "official_verified"
  | "source_listed"
  | "verification_pending"
  | "closed_confirmed"
  | "destination_mismatch"
  | "security_blocked";

export function badgeFor(status: string | null | undefined): BadgeKind {
  switch (canonicalAvailability(status)) {
    case AVAILABILITY.OFFICIAL_VERIFIED:
      return "official_verified";
    case AVAILABILITY.ACTIVE_SOURCE_LISTED:
      return "source_listed";
    case AVAILABILITY.VERIFICATION_PENDING:
      return "verification_pending";
    case AVAILABILITY.CLOSED_CONFIRMED:
      return "closed_confirmed";
    case AVAILABILITY.DESTINATION_MISMATCH:
      return "destination_mismatch";
    case AVAILABILITY.SECURITY_BLOCKED:
      return "security_blocked";
  }
}

// The three availability states that appear in the default active feed.
export function isActiveAvailability(status: string | null | undefined): boolean {
  const a = canonicalAvailability(status);
  return (
    a === AVAILABILITY.OFFICIAL_VERIFIED ||
    a === AVAILABILITY.ACTIVE_SOURCE_LISTED ||
    a === AVAILABILITY.VERIFICATION_PENDING
  );
}
