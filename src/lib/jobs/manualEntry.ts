/**
 * What a hand-entered posting is allowed to claim about itself.
 *
 * This used to live inline in `POST /api/jobs`, which made it reachable only
 * over HTTP — so the contract that guards it ("a manual entry states when it was
 * checked and never claims permanence") could only be tested by standing up a
 * server. It is a policy, not a routing concern, so it lives here and the route
 * calls it.
 *
 * The wording is load-bearing rather than cosmetic. A manual entry is trusted
 * because a person pasted it in, not because anything re-checked the employer's
 * page, and the reason string has to say so: it names the moment of the check
 * and never promises the posting is permanently open.
 */

export type ManualEntryResolution = "RESOLVED" | (string & {});

export type ManualEntryVerification = {
  verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK" | "NeedsReview";
  reasonCode: "MANUAL_ENTRY" | "OFFICIAL_DESTINATION_UNRESOLVED";
  verificationReason: string;
  verificationMethod: "manual-entry";
  /** Hostname of the official application URL, when there is a valid one. */
  officialEmployerDomain: string | null;
};

/** The employer hostname, or null when the URL is absent or unparseable. */
export function officialEmployerDomainFrom(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function manualEntryVerification(input: {
  resolutionStatus: ManualEntryResolution;
  officialApplicationUrl: string | null;
  enteredAt: Date;
}): ManualEntryVerification {
  const resolved = input.resolutionStatus === "RESOLVED";
  return {
    verificationStatus: resolved ? "VERIFIED_OFFICIAL_AT_LAST_CHECK" : "NeedsReview",
    reasonCode: resolved ? "MANUAL_ENTRY" : "OFFICIAL_DESTINATION_UNRESOLVED",
    verificationReason: resolved
      ? `Verified on the official employer application page at ${input.enteredAt.toLocaleString()}. (Manually entered by the user — not independently re-checked.)`
      : "The manually entered URL is not a job-specific employer or ATS application page.",
    verificationMethod: "manual-entry",
    officialEmployerDomain: officialEmployerDomainFrom(input.officialApplicationUrl),
  };
}
