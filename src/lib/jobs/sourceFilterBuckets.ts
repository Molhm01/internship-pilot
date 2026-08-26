import { DIRECT_OFFICIAL_SOURCES } from "./sourcePolicy";

/**
 * The Source filter's UI buckets, grounded in the raw `Job.source` string
 * literals the discovery pipeline actually writes (see discoveryResolution.ts,
 * ingest.ts, liveDiscoveryQueue.ts, supplementalRadarQueue.ts) rather than an
 * invented taxonomy. "Public/direct feed" discovery resolves to whichever ATS
 * adapter it detected (or "other"), so it has no distinct token of its own —
 * it shows up under Official/ATS or Other depending on what was found.
 */
export const SOURCE_FILTER_BUCKETS = {
  official_ats: [...DIRECT_OFFICIAL_SOURCES],
  intern_list: ["intern-list", "intern-list-public"],
  aggregator: ["jobright", "jobright-fresh", "simplify"],
  manual: ["manual"],
  other: ["other"],
} as const;

export type SourceFilterBucket = keyof typeof SOURCE_FILTER_BUCKETS;

export const SOURCE_FILTER_OPTIONS: ReadonlyArray<{ value: SourceFilterBucket | ""; label: string }> = [
  { value: "", label: "All sources" },
  { value: "official_ats", label: "Official / ATS" },
  { value: "intern_list", label: "Intern List" },
  { value: "aggregator", label: "Aggregator (Jobright / Simplify)" },
  { value: "manual", label: "Manual entry" },
  { value: "other", label: "Other / unclassified" },
];

/** Raw `Job.source` values a bucket key matches, or null for an unknown/empty key. */
export function sourcesForBucket(bucket: string | null | undefined): string[] | null {
  if (!bucket) return null;
  if (bucket in SOURCE_FILTER_BUCKETS) return [...SOURCE_FILTER_BUCKETS[bucket as SourceFilterBucket]];
  return null;
}
