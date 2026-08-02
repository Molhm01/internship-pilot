// The ONE canonical internship classifier.
//
// Every ingestion path (ATS adapters today, legacy Intern List rows during
// backfill) routes through classifyInternship() so that "is this an
// internship?" has exactly one answer in the product rather than a different
// regex per adapter.
//
// Design rule: never silently drop a record. Anything we cannot confidently
// place lands in UNCERTAIN_CLASSIFICATION with a human-readable reason and
// stays reviewable, because a false NOT_AN_INTERNSHIP is invisible data loss
// — the exact failure mode this work exists to fix.

export type InternshipClassification =
  | "QUALIFYING_INTERNSHIP"
  | "NOT_AN_INTERNSHIP"
  | "UNCERTAIN_CLASSIFICATION"
  | "CONFIRMED_CLOSED"
  | "PARSE_FAILED";

export type ClassificationInput = {
  title?: string | null;
  description?: string | null;
  employmentType?: string | null;
  /** Adapter-supplied signal that the posting is no longer open. */
  closed?: boolean | null;
};

export type ClassificationResult = {
  classification: InternshipClassification;
  reason: string;
};

// --- Signal vocabularies -------------------------------------------------
//
// Word boundaries matter more than they look here. `\bintern\b` deliberately
// does NOT match "internal" or "international" (a word character follows
// "intern"), which is the single most common false positive in job titles.

const STRONG_INTERN = /\bintern(ship)?s?\b/i;
const CO_OP = /\bco-?ops?\b|\bcooperative education\b/i;
const STUDENT_TRAINEE = /\bstudent\s+(trainee|worker|engineer|researcher|assistant|associate)\b/i;
const APPRENTICE = /\bapprentice(ship)?s?\b/i;
const SUMMER_ROLE = /\bsummer\s+(analyst|associate|scholar|fellow)\b/i;
const CAMPUS_PROGRAM = /\b(campus|university|college)\s+(hire|program|recruiting|graduate)\b/i;

// Student-context corroboration used to promote an ambiguous "Summer
// Analyst"-style title into a qualifying internship.
const STUDENT_CONTEXT =
  /\b(undergraduate|undergrad|current(ly)?\s+enrolled|pursuing\s+a?\s*(bachelor|master|b\.?s\.?|m\.?s\.?)|rising\s+(junior|senior|sophomore)|degree\s+in\s+progress|expected\s+graduation|class\s+of\s+20\d\d|student)\b/i;

// Seniority markers that rule a posting out — but only when no internship
// signal is present (an "Intern, Senior Data Platform Team" is still an
// internship; the seniority word describes the team, not the hire).
const SENIOR_TITLE =
  /\b(senior|sr\.?|staff|principal|lead|manager|director|head\s+of|vp|vice\s+president|chief|architect|fellow\s+engineer|distinguished)\b/i;
const LEVELED_TITLE = /\b(ii|iii|iv|v|2|3|4|5)\b\s*$/i;
const EXPERIENCE_DEMAND = /\b(\d{1,2})\+?\s*(\+|or\s+more)?\s*years?(\s+of)?\s+(relevant\s+|professional\s+|industry\s+)?experience\b/i;

const FULL_TIME_TYPE = /\b(full[\s-]?time|permanent|regular\s+full)\b/i;
const INTERN_TYPE = /\b(intern(ship)?|co-?op|temporary|seasonal|part[\s-]?time\s+student)\b/i;

const CLOSED_MARKER = /\b(no longer accepting|position (has been )?filled|posting closed|this (job|role|posting) is closed|applications are closed)\b/i;

function firstExperienceDemand(text: string): number | null {
  const m = text.match(EXPERIENCE_DEMAND);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Classify a posting. Pure and synchronous — no network, no database — so it
 * is cheap to call per record and trivial to test exhaustively.
 */
export function classifyInternship(input: ClassificationInput): ClassificationResult {
  const title = (input.title ?? "").trim();
  const description = (input.description ?? "").trim();
  const employmentType = (input.employmentType ?? "").trim();

  // A record with no title at all cannot be judged or displayed usefully.
  if (!title) {
    return { classification: "PARSE_FAILED", reason: "Record has no title." };
  }

  if (input.closed === true) {
    return { classification: "CONFIRMED_CLOSED", reason: "Source reported the posting as closed." };
  }
  if (CLOSED_MARKER.test(description)) {
    return {
      classification: "CONFIRMED_CLOSED",
      reason: "Posting text states it is no longer accepting applications.",
    };
  }

  const titleHasIntern = STRONG_INTERN.test(title);
  const titleHasCoOp = CO_OP.test(title);
  const titleHasTrainee = STUDENT_TRAINEE.test(title);
  const titleHasApprentice = APPRENTICE.test(title);
  const titleHasSummerRole = SUMMER_ROLE.test(title);

  // --- Tier 1: unambiguous title signals --------------------------------
  if (titleHasIntern) {
    return { classification: "QUALIFYING_INTERNSHIP", reason: 'Title contains "intern"/"internship".' };
  }
  if (titleHasCoOp) {
    return { classification: "QUALIFYING_INTERNSHIP", reason: "Title identifies a co-op / cooperative education role." };
  }
  if (titleHasTrainee) {
    return { classification: "QUALIFYING_INTERNSHIP", reason: "Title identifies a student trainee role." };
  }

  // Apprenticeships are intentionally in scope — the product already tracks
  // them alongside co-ops as student-entry pathways.
  if (titleHasApprentice) {
    return { classification: "QUALIFYING_INTERNSHIP", reason: "Title identifies an apprenticeship." };
  }

  // --- Tier 2: employment-type metadata ---------------------------------
  if (INTERN_TYPE.test(employmentType) && !FULL_TIME_TYPE.test(employmentType)) {
    return {
      classification: "QUALIFYING_INTERNSHIP",
      reason: `Employment type "${employmentType}" indicates an internship/co-op.`,
    };
  }

  // --- Tier 3: ambiguous titles needing student corroboration -----------
  // "Summer Analyst" is an internship at a bank and a seasonal staff job
  // elsewhere, so it only qualifies with explicit student context.
  if (titleHasSummerRole || CAMPUS_PROGRAM.test(title)) {
    if (STUDENT_CONTEXT.test(description) || STRONG_INTERN.test(description) || CO_OP.test(description)) {
      return {
        classification: "QUALIFYING_INTERNSHIP",
        reason: "Seasonal/campus title corroborated by student-eligibility language in the description.",
      };
    }
    return {
      classification: "UNCERTAIN_CLASSIFICATION",
      reason: "Seasonal/campus title with no explicit student-eligibility language; needs review.",
    };
  }

  // --- Tier 4: clear exclusions -----------------------------------------
  const years = firstExperienceDemand(description);
  if (years !== null && years >= 3) {
    return {
      classification: "NOT_AN_INTERNSHIP",
      reason: `Posting requires ${years}+ years of experience.`,
    };
  }
  if (SENIOR_TITLE.test(title)) {
    return {
      classification: "NOT_AN_INTERNSHIP",
      reason: "Title indicates a senior, lead, or management role.",
    };
  }
  if (LEVELED_TITLE.test(title)) {
    return {
      classification: "NOT_AN_INTERNSHIP",
      reason: "Title carries an experienced engineer level suffix.",
    };
  }
  if (FULL_TIME_TYPE.test(employmentType)) {
    return {
      classification: "NOT_AN_INTERNSHIP",
      reason: `Employment type "${employmentType}" indicates a permanent full-time role.`,
    };
  }

  // --- Tier 5: body-only internship signals -----------------------------
  // The title said nothing either way. A body that talks about interns is
  // suggestive but not conclusive (job pages often describe the wider
  // program), so this is reviewable rather than auto-accepted.
  if (STRONG_INTERN.test(description) || CO_OP.test(description) || STUDENT_CONTEXT.test(description)) {
    return {
      classification: "UNCERTAIN_CLASSIFICATION",
      reason: "Internship/student language appears only in the description, not the title; needs review.",
    };
  }

  return {
    classification: "NOT_AN_INTERNSHIP",
    reason: "No internship, co-op, or student-eligibility signal in the title, type, or description.",
  };
}

/** Classifications that belong in the product's active internship feed. */
export function isQualifying(classification: InternshipClassification): boolean {
  return classification === "QUALIFYING_INTERNSHIP";
}

/**
 * Records that must remain visible to a reviewer rather than vanishing.
 * UNCERTAIN rows are persisted and surfaced for review — never dropped.
 */
export function isReviewable(classification: InternshipClassification): boolean {
  return classification === "UNCERTAIN_CLASSIFICATION";
}
