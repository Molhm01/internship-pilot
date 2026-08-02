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
  DISCOVERED: "bg-slate-100 text-slate-700 border-slate-300",
  VERIFIED: "bg-sky-100 text-sky-700 border-sky-300",
  INELIGIBLE: "bg-neutral-200 text-neutral-600 border-neutral-300",
  TAILORING: "bg-amber-100 text-amber-700 border-amber-300",
  DOCUMENT_QA: "bg-amber-100 text-amber-800 border-amber-300",
  READY_TO_APPLY: "bg-indigo-100 text-indigo-700 border-indigo-300",
  QUEUED: "bg-indigo-100 text-indigo-800 border-indigo-300",
  APPLYING: "bg-cyan-100 text-cyan-700 border-cyan-300",
  NEEDS_USER_ACTION: "bg-orange-100 text-orange-800 border-orange-300",
  SUBMITTED: "bg-blue-100 text-blue-700 border-blue-300",
  ASSESSMENT_REQUIRED: "bg-purple-100 text-purple-700 border-purple-300",
  INTERVIEW: "bg-violet-100 text-violet-700 border-violet-300",
  REJECTED: "bg-rose-100 text-rose-700 border-rose-300",
  OFFER: "bg-emerald-100 text-emerald-700 border-emerald-300",
  CLOSED: "bg-neutral-200 text-neutral-600 border-neutral-300",
  FAILED: "bg-red-100 text-red-700 border-red-300",
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
