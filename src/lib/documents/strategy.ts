// Document strategy — separates RESUME TAILORING from FORM AUTOFILL.
//
// An incomplete official job description (missing Responsibilities/
// Qualifications sections) must NEVER block the Application Agent. It only
// changes WHICH resume is used. The agent still opens the page, initializes
// the extension, fills profile fields, and uploads the selected resume.

export type DocumentStrategy =
  | "TAILORED" // complete job description → job-tailored resume
  | "PARTIAL_TAILORING" // partial description → tailor only where supported
  | "MASTER_RESUME_FALLBACK" // no usable description → approved master resume
  | "EXISTING_APPROVED_DOCUMENT" // reuse a previously generated approved doc
  | "NO_APPROVED_DOCUMENT"; // the ONLY document state that blocks upload

// Job-description completeness, used to choose a strategy.
export type JobDescriptionCompleteness = "complete" | "partial" | "none";

export function jobDescriptionCompleteness(job: {
  description?: string | null;
  jobResponsibilities?: string | null;
  jobQualifications?: string | null;
}): JobDescriptionCompleteness {
  const hasResp = Boolean(job.jobResponsibilities && safeJsonNonEmpty(job.jobResponsibilities));
  const hasQual = Boolean(job.jobQualifications && safeJsonNonEmpty(job.jobQualifications));
  if (hasResp && hasQual) return "complete";
  const desc = (job.description ?? "").trim();
  // A meaningful amount of description text (or one of the two sections) is
  // enough to tailor partially.
  if (desc.length >= 120 || hasResp || hasQual) return "partial";
  return "none";
}

function safeJsonNonEmpty(json: string): boolean {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.length > 0 : Boolean(parsed);
  } catch {
    return (json ?? "").trim().length > 0;
  }
}

// Map a generated resume's stored tailoringStatus to the strategy that produced
// it. Legacy "NOT_TAILORED_NO_JOB_DESCRIPTION" documents are treated as a valid
// master-resume fallback (usable), never as a blocker.
export function strategyFromTailoringStatus(tailoringStatus: string | null | undefined): DocumentStrategy {
  switch (tailoringStatus) {
    case "TAILORED_WITH_SUPPORTED_CHANGES":
    case "MASTER_UNCHANGED_NO_SUPPORTED_IMPROVEMENT":
    case "TAILORED":
      return "TAILORED";
    case "PARTIAL_TAILORING":
      return "PARTIAL_TAILORING";
    case "MASTER_RESUME_FALLBACK":
    case "NOT_TAILORED_NO_JOB_DESCRIPTION":
      return "MASTER_RESUME_FALLBACK";
    default:
      return "MASTER_RESUME_FALLBACK";
  }
}

// The tailoringStatus value generate.ts should store, given completeness.
export function tailoringStatusForCompleteness(
  completeness: JobDescriptionCompleteness,
  auditStatus: string,
): string {
  if (completeness === "complete") return auditStatus; // TAILORED_* / MASTER_UNCHANGED_*
  if (completeness === "partial") return "PARTIAL_TAILORING";
  return "MASTER_RESUME_FALLBACK";
}

// A resume document is USABLE for upload whenever it is a QA-passed, identity-
// verified resume for this job — regardless of how tailored it is. Only the
// ABSENCE of such a document (NO_APPROVED_DOCUMENT) blocks upload.
export function isUsableResume(document: {
  type: string;
  qaStatus: string;
  identityVerified: boolean;
}): boolean {
  return document.type === "resume" && document.qaStatus === "pass" && document.identityVerified;
}

export function documentStrategyReason(strategy: DocumentStrategy, completeness: JobDescriptionCompleteness): string {
  switch (strategy) {
    case "TAILORED":
      return "Complete job-description sections were available; using the job-tailored resume.";
    case "PARTIAL_TAILORING":
      return "Only a partial job description was available; tailoring was applied where supported and confidence is lowered.";
    case "MASTER_RESUME_FALLBACK":
      return "Complete job-description sections were unavailable. Internship Pilot is using your approved master resume and will continue autofilling.";
    case "EXISTING_APPROVED_DOCUMENT":
      return `Reusing a previously generated, approved resume for this job (source description was ${completeness}); not regenerating.`;
    case "NO_APPROVED_DOCUMENT":
      return "No approved resume exists yet. Generate documents (or approve a master resume) before autofill can upload a resume.";
  }
}
