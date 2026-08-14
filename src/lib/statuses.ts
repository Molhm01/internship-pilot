// Milestone 8 tracker vocabulary. Renamed from the Phase 1 set
// (Discovered/Saved/Tailoring/Ready/Submitted/Assessment/Interview/Rejected/
// Offer/Withdrawn) via a data migration — see
// prisma/migrations/*_m8_tracker_statuses for the value mapping applied to
// existing rows.
export const TRACKER_STATUSES = [
  "DISCOVERED",
  "VERIFIED",
  "INELIGIBLE",
  "TAILORING",
  "DOCUMENT_QA",
  "READY_TO_APPLY",
  "QUEUED",
  "APPLYING",
  "NEEDS_USER_ACTION",
  "SUBMITTED",
  "ASSESSMENT_REQUIRED",
  "INTERVIEW",
  "REJECTED",
  "OFFER",
  "CLOSED",
  "FAILED",
] as const;

export type TrackerStatus = (typeof TRACKER_STATUSES)[number];

export const STATUS_LABELS: Record<TrackerStatus, string> = {
  DISCOVERED: "Discovered",
  VERIFIED: "Verified",
  INELIGIBLE: "Ineligible",
  TAILORING: "Tailoring",
  DOCUMENT_QA: "Document QA",
  READY_TO_APPLY: "Ready to Apply",
  QUEUED: "Queued",
  APPLYING: "Applying",
  NEEDS_USER_ACTION: "Needs Your Action",
  SUBMITTED: "Submitted",
  ASSESSMENT_REQUIRED: "Assessment Required",
  INTERVIEW: "Interview",
  REJECTED: "Rejected",
  OFFER: "Offer",
  CLOSED: "Closed",
  FAILED: "Failed",
};

export const STATUS_COLORS: Record<TrackerStatus, string> = {
  DISCOVERED: "bg-n-150 text-secondary border-line",
  VERIFIED: "bg-info-quiet text-info border-info-line",
  INELIGIBLE: "bg-n-150 text-tertiary border-line",
  TAILORING: "bg-caution-quiet text-caution border-caution-line",
  DOCUMENT_QA: "bg-caution-quiet text-caution border-caution-line",
  READY_TO_APPLY: "bg-accent-quiet text-accent-text border-accent-line",
  QUEUED: "bg-accent-quiet text-accent-text border-accent-line",
  APPLYING: "bg-accent-quiet text-accent-text border-accent-line",
  NEEDS_USER_ACTION: "bg-caution-quiet text-caution border-caution-line",
  SUBMITTED: "bg-info-quiet text-info border-info-line",
  ASSESSMENT_REQUIRED: "bg-info-quiet text-info border-info-line",
  INTERVIEW: "bg-accent-quiet text-accent-text border-accent-line",
  REJECTED: "bg-critical-quiet text-critical border-critical-line",
  OFFER: "bg-verified-quiet text-verified border-verified-line",
  CLOSED: "bg-n-150 text-tertiary border-line",
  FAILED: "bg-critical-quiet text-critical border-critical-line",
};

export const FACT_TYPES = [
  "education",
  "gpa",
  "graduationDate",
  "coursework",
  "skill",
  "project",
  "experience",
  "activity",
] as const;

export type FactType = (typeof FACT_TYPES)[number];

export const FACT_TYPE_LABELS: Record<FactType, string> = {
  education: "Education",
  gpa: "GPA",
  graduationDate: "Graduation Date",
  coursework: "Coursework",
  skill: "Skill",
  project: "Project",
  experience: "Experience",
  activity: "Activity",
};
