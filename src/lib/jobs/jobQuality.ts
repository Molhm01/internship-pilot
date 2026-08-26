import { hasUsableJobDescription } from "@/lib/matchWorkflow";

export type DateQuality = "EXACT_TIMESTAMP" | "DATE_ONLY" | "UNKNOWN";
export type JobDescriptionQuality = "FULL" | "USABLE" | "THIN" | "MISSING";
export type DestinationQuality = "CANONICAL_OFFICIAL" | "OFFICIAL_BOARD" | "UNRESOLVED";

export function dateQuality(job: {
  sourcePostedAt?: Date | string | null;
  sourceDateConfidence?: string | null;
}): DateQuality {
  if (!job.sourcePostedAt) return "UNKNOWN";
  return job.sourceDateConfidence === "EXACT" ? "EXACT_TIMESTAMP" : "DATE_ONLY";
}

export function jobDescriptionQuality(job: {
  description?: string | null;
  jobResponsibilities?: string | null;
  jobQualifications?: string | null;
}): JobDescriptionQuality {
  const description = job.description?.trim() ?? "";
  if (!description) return "MISSING";
  if (!hasUsableJobDescription({
    description,
    jobResponsibilities: job.jobResponsibilities ?? null,
    jobQualifications: job.jobQualifications ?? null,
  })) return "THIN";
  if (description.length >= 500 && !/\.\.\.\s*$/.test(description)) return "FULL";
  return "USABLE";
}

export function destinationQuality(job: {
  officialApplicationUrl?: string | null;
  officialJobUrl?: string | null;
  sourceListingUrl?: string | null;
  resolutionStatus?: string | null;
  verificationStatus?: string | null;
}): DestinationQuality {
  if (job.officialApplicationUrl && (
    job.resolutionStatus === "RESOLVED"
    || job.verificationStatus === "VERIFIED_OFFICIAL_AT_LAST_CHECK"
  )) return "CANONICAL_OFFICIAL";
  if (job.officialJobUrl || job.sourceListingUrl) return "OFFICIAL_BOARD";
  return "UNRESOLVED";
}
