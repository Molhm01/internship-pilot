// Canonical verification statuses for ApplicationSession handoff.
// This is an updated union that allows ACTIVE_SOURCE_LISTED as a valid state
// when a job has a valid destination URL, while maintaining compatibility with
// existing schema structures

export const CANONICAL_VERIFICATION_STATUSES = [
  "VERIFIED_OFFICIAL_AT_LAST_CHECK",
  "ACTIVE_SOURCE_LISTED",
  "VERIFICATION_PENDING", 
  "CLOSED_CONFIRMED",
  "DESTINATION_MISMATCH",
  "SECURITY_BLOCKED"
] as const;

export type CanonicalVerificationStatus = (typeof CANONICAL_VERIFICATION_STATUSES)[number];

/** Narrows an arbitrary string to one of the canonical statuses. */
function isCanonicalVerificationStatus(status: string | null | undefined): status is CanonicalVerificationStatus {
  return CANONICAL_VERIFICATION_STATUSES.some((candidate) => candidate === status);
}

// Converts old/legacy verification statuses to canonical ones
export function canonicalVerificationStatus(status: string | null | undefined): CanonicalVerificationStatus {
  // Handle exact matches first for existing cases  
  if (isCanonicalVerificationStatus(status)) return status;
  
  // Map legacy statuses 
  switch (status) {
    case "VERIFIED_OFFICIAL_AT_LAST_CHECK":
      return "VERIFIED_OFFICIAL_AT_LAST_CHECK";
    case "ACTIVE_SOURCE_LISTED":
      return "ACTIVE_SOURCE_LISTED";
    case "VERIFICATION_PENDING":
    case "Pending":
    case "NeedsReview":
      return "VERIFICATION_PENDING";
    case "Closed":
    case "CLOSED_CONFIRMED":
      return "CLOSED_CONFIRMED";
    case "DESTINATION_MISMATCH":
      return "DESTINATION_MISMATCH"; 
    case "SecurityQuarantine":
      return "SECURITY_BLOCKED";
    // Legacy rows that were in the old false-closure state
    case "CLOSED_OR_UNVERIFIED":
      return "ACTIVE_SOURCE_LISTED";
    default:
      return "ACTIVE_SOURCE_LISTED"; // Default fallback
  }
}

// Validation function that allows ACTIVE_SOURCE_LISTED for application session handoff
export function canCreateApplicationSession(verificationStatus: string | null | undefined): boolean {
  const canonicalStatus = canonicalVerificationStatus(verificationStatus);
  
  // These statuses are valid for ApplicationSession creation (when we have a URL)
  switch (canonicalStatus) {
    case "VERIFIED_OFFICIAL_AT_LAST_CHECK":
    case "ACTIVE_SOURCE_LISTED":
      return true;
    default:
      return false;  // These cannot be used for ApplicationSession
  }
}