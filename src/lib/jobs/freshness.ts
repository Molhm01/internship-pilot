export const KNOWN_POSTED_FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const UNKNOWN_DATE_DISCOVERED_WINDOW_MS = 72 * 60 * 60 * 1000;

export type DiscoverFreshnessGroup =
  | "KNOWN_POSTED_LT_24H"
  | "KNOWN_POSTED_LT_72H"
  | "KNOWN_POSTED_LE_7D"
  | "UNKNOWN_DISCOVERED_LT_24H"
  | "UNKNOWN_DISCOVERED_LE_72H"
  | "NOT_FRESH";

type FreshnessEvidence = {
  sourcePostedAt?: Date | string | null;
  firstSeenAt?: Date | string | null;
};

function ageMs(value: Date | string | null | undefined, now: Date): number | null {
  if (!value) return null;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const age = now.getTime() - timestamp;
  return age >= 0 ? age : null;
}

/**
 * Employer posting evidence wins. Without it, discovery time can grant a
 * bounded Fresh placement but is never promoted to `sourcePostedAt`.
 */
export function discoverFreshnessGroup(
  job: FreshnessEvidence,
  now: Date = new Date(),
): DiscoverFreshnessGroup {
  const postedAge = ageMs(job.sourcePostedAt, now);
  if (postedAge !== null) {
    if (postedAge < 24 * 60 * 60 * 1000) return "KNOWN_POSTED_LT_24H";
    if (postedAge < 72 * 60 * 60 * 1000) return "KNOWN_POSTED_LT_72H";
    if (postedAge <= KNOWN_POSTED_FRESH_WINDOW_MS) return "KNOWN_POSTED_LE_7D";
    return "NOT_FRESH";
  }

  const discoveredAge = ageMs(job.firstSeenAt, now);
  if (discoveredAge === null) return "NOT_FRESH";
  if (discoveredAge < 24 * 60 * 60 * 1000) return "UNKNOWN_DISCOVERED_LT_24H";
  if (discoveredAge <= UNKNOWN_DATE_DISCOVERED_WINDOW_MS) return "UNKNOWN_DISCOVERED_LE_72H";
  return "NOT_FRESH";
}

export function discoverFreshnessLabel(
  job: FreshnessEvidence,
  now: Date = new Date(),
): "NEW" | "RECENT" | "NEWLY_DISCOVERED" | null {
  const group = discoverFreshnessGroup(job, now);
  if (group === "KNOWN_POSTED_LT_24H") return "NEW";
  if (group === "KNOWN_POSTED_LT_72H" || group === "KNOWN_POSTED_LE_7D") return "RECENT";
  if (group.startsWith("UNKNOWN_DISCOVERED_")) return "NEWLY_DISCOVERED";
  return null;
}
