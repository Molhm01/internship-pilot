export type AtsType =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workday"
  | "smartrecruiters"
  | "icims"
  | "taleo"
  | "successfactors"
  | "unknown";

export type ApplicationMode = "OFF" | "FILL_TO_SUBMIT";

// Every reason the worker is allowed to stop and hand control back to the
// user. Never bypassed, never "worked around" — these are hard stops.
export type StopReason =
  | "captcha"
  | "mfa"
  | "login_required"
  | "assessment_required"
  | "unknown_question"
  | "essay_without_approved_answer"
  | "citizenship_clearance_sponsorship_ambiguous"
  | "eeo_no_saved_preference"
  | "requested_info_not_stored"
  | "conflicting_data"
  | "upload_failed"
  | "terms_confirmation_required"
  | "unsupported_ats"
  | "form_not_found"
  | "duplicate_requisition"
  | "posting_closed_before_submit"
  | "security_quarantine"
  | "model_output_invalid";

export const STOP_REASON_LABELS: Record<StopReason, string> = {
  captcha: "Complete the CAPTCHA in the application browser, then click Resume.",
  mfa: "Complete MFA in the application browser, then click Resume.",
  login_required: "Log in in the application browser, then click Resume.",
  assessment_required: "This application requires completing a hiring assessment.",
  unknown_question: "The form asked a question with no confident, grounded answer.",
  essay_without_approved_answer: "A free-text essay question could not be answered from approved facts — grounded generation was attempted and found insufficient evidence, so nothing was written rather than guessed.",
  citizenship_clearance_sponsorship_ambiguous:
    "The form asked about citizenship, sponsorship, or security clearance and no answer is saved in your Application Profile.",
  eeo_no_saved_preference: "The form asked an EEO/demographic question and no preference is saved in your Application Profile.",
  requested_info_not_stored: "The form asked for information that isn't stored anywhere in your profile or facts.",
  conflicting_data: "Two fields on the form conflicted with each other or with your stored data.",
  upload_failed: "A file (resume or cover letter) failed to upload.",
  terms_confirmation_required: "The form requires confirming terms/certifications that need your explicit review.",
  unsupported_ats: "This employer's application platform isn't supported yet.",
  form_not_found: "The application form could not be located on the page.",
  duplicate_requisition: "An application to this exact requisition already exists.",
  posting_closed_before_submit: "The posting closed (or its link became unsafe) between opening the application and submitting it — stopped before clicking Submit.",
  security_quarantine: "This application was flagged by fraud protection and moved to Security Quarantine — never autofilled or submitted.",
  model_output_invalid: "The local model returned invalid structured actions after two correction retries.",
};

export type RunStatus = "queued" | "running" | "needs_user_action" | "filled" | "submitted" | "failed" | "cancelled" | "superseded";

export type KnownAnswerCategory =
  | "identity" // name, email, phone
  | "links" // linkedin, github, website
  | "school"
  | "education"
  | "experience"
  | "resume_file"
  | "cover_letter_file"
  | "cover_letter_text"
  | "work_authorization"
  | "eeo"
  | "how_heard"
  | "address"
  | "country"
  | "relocation"
  | "availability"
  | "salary"
  | "unknown";

export interface FillContext {
  jobId: string;
  runId: string;
  jobTitle: string;
  company: string;
  applyUrl: string;
  mode: "fill_to_submit" | "auto_submit";
  profile: {
    fullName: string | null;
    preferredName: string | null;
    email: string | null;
    phone: string | null;
    linkedin: string | null;
    github: string | null;
    website: string | null;
    school: string | null;
    previousSchool: string | null;
    addressStreet: string | null;
    addressCity: string | null;
    addressState: string | null;
    addressZip: string | null;
    countryOfResidence: string | null;
    willingToRelocate: boolean | null;
    locationPreferences: string[] | null;
    internshipTermAvailability: string | null;
    /** YYYY-MM-DD, from ApplicationPreferences.earliestStartDate — populated in practice; internshipTermAvailability above currently is not. */
    earliestStartDate: string | null;
    salaryAnswerPreference: string | null;
    workAuthorization: string | null;
    requiresSponsorship: boolean | null;
    clearanceEligible: boolean | null;
    eeoGender: string | null;
    eeoRaceEthnicity: string | null;
    eeoVeteranStatus: string | null;
    eeoDisabilityStatus: string | null;
  };
  resumeFilePath: string | null;
  coverLetterFilePath: string | null;
  coverLetterText: string | null;
  educationDegree?: string | null;
  recentExperience?: string | null;
  approvedRunAnswers?: Record<string, string>;
  /** The full job description, for grounded long-answer generation (see longAnswer.ts). */
  jobDescription?: string | null;
  /** Approved-bullet work history, for "leadership"/"technical interest" long answers. */
  approvedExperiences?: ReadonlyArray<{ employer: string; title: string | null; approvedBullets: string[] }>;
  /** Approved project descriptions, for "describe a project" long answers. */
  approvedProjects?: ReadonlyArray<{ name: string; description: string | null; approvedSkills: string[] }>;
  /** This employer specifically — referral/family-at-company facts. Never guessed if absent. */
  companyRelationship?: {
    hasReferral: boolean | null;
    referralName: string | null;
    referralRelationship: string | null;
    familyMemberEmployed: boolean | null;
  } | null;
}

export interface StoppedFieldDetails {
  label: string;
  type: string;
  required: boolean;
  options: string[];
  step: number;
  ariaLabel: string;
  placeholder: string;
  nearbyText: string;
  pageUrl: string;
}

export interface FillResult {
  status: "filled" | "needs_user_action" | "submitted" | "failed";
  stopReason?: StopReason;
  stoppedFieldLabel?: string; // the exact field label that triggered the stop, so the user can supply/save an answer for reuse
  stoppedField?: StoppedFieldDetails;
  answers: Record<string, string>;
  screenshotPath?: string;
  confirmationNumber?: string;
  confirmationUrl?: string;
  error?: string;
}

export function classifyErrorCode(errorText: string | null | undefined): { errorCode: string; validationPath?: string } {
  const text = String(errorText || "");
  if (!text) return { errorCode: "UNKNOWN" };

  if (/diagnostic_external_navigation_blocked/i.test(text)) {
    return { errorCode: "diagnostic_external_navigation_blocked" };
  }
  if (/FORM_DESCRIPTION_VERSION_MISMATCH/i.test(text) || /Version mismatch/i.test(text)) {
    return { errorCode: "FORM_DESCRIPTION_VERSION_MISMATCH" };
  }
  if (/FORM_DESCRIPTION_INVALID/i.test(text) || /invalid form description/i.test(text)) {
    const matchPath = text.match(/\((?:path:\s*)?([a-zA-Z0-9_.\[\]]+)\)/) || text.match(/(fields\[\d+\]\.[a-zA-Z0-9_]+)/);
    return {
      errorCode: "FORM_DESCRIPTION_INVALID",
      validationPath: matchPath ? matchPath[1] : undefined,
    };
  }
  if (/EXTENSION_DISCONNECTED/i.test(text) || /did not inject its in-page autofill button/i.test(text)) {
    return { errorCode: "EXTENSION_DISCONNECTED" };
  }
  if (/TAB_CLOSED/i.test(text) || /closed/i.test(text)) {
    return { errorCode: "TAB_CLOSED" };
  }
  if (/SERVER_UNAVAILABLE/i.test(text) || /unreachable/i.test(text)) {
    return { errorCode: "SERVER_UNAVAILABLE" };
  }
  if (/upload/i.test(text)) {
    return { errorCode: "UPLOAD_FAILED" };
  }
  if (/timeout/i.test(text) || /45 seconds/i.test(text)) {
    return { errorCode: "DOM_SCAN_TIMEOUT" };
  }
  if (/No readable application form/i.test(text)) {
    return { errorCode: "UNSUPPORTED_FIELD" };
  }
  if (/user/i.test(text)) {
    return { errorCode: "USER_REVIEW_REQUIRED" };
  }
  return { errorCode: "WORKER_CRASH" };
}
