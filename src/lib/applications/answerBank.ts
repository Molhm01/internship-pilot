import type { FillContext, KnownAnswerCategory } from "./types";

// Classifies a form field's label text into a category, and returns the
// answer to use — or null if the agent doesn't have a confidently grounded
// answer, which the caller must treat as a stop condition (never a guess).
export function classifyField(labelText: string): KnownAnswerCategory {
  const t = labelText.toLowerCase();

  if (/security clearance/.test(t)) return "work_authorization";
  if (/sponsorship|visa\b/.test(t)) return "work_authorization";
  if (/\bcitizen(ship)?\b/.test(t)) return "work_authorization";
  if (/authoriz(ed|ation) to work|eligib(le|ility) to work|legally (able|authorized) to work/.test(t)) return "work_authorization";
  if (/country( of (residence|domicile))?|where do you (currently )?(live|reside)/.test(t)) return "country";

  if (/\bgender\b/.test(t)) return "eeo";
  if (/\brace\b|ethnicity/.test(t)) return "eeo";
  if (/veteran/.test(t)) return "eeo";
  if (/disabilit/.test(t)) return "eeo";

  if (/cover\s*letter/.test(t) && /(attach|upload|file)/.test(t)) return "cover_letter_file";
  if (/cover\s*letter/.test(t)) return "cover_letter_text";
  if (/r[ée]sum[ée]|\bcv\b/.test(t)) return "resume_file";

  if (/linkedin/.test(t)) return "links";
  if (/github/.test(t)) return "links";
  if (/website|portfolio/.test(t)) return "links";

  if (/school|university|college/.test(t)) return "school";
  if (/degree|major|field of study/.test(t)) return "education";
  if (/most recent (role|experience|position)|current role|recent experience/.test(t)) return "experience";

  if (/street address|address line|\bzip\b|postal code|\bcity\b|\bstate\b(?!ment)|current location/.test(t)) return "address";
  if (/willing(ness)? to relocate|open to relocat/.test(t)) return "relocation";
  if (/available (to start|start date)|start date|internship term|when (can|are) you (start|available)/.test(t)) return "availability";
  if (/salary expect|desired (salary|pay|compensation)|compensation expect/.test(t)) return "salary";

  if (/e-?mail/.test(t)) return "identity";
  if (/phone|mobile/.test(t)) return "identity";
  if (/first\s*name|last\s*name|full\s*name|your\s*name|^name$/.test(t)) return "identity";

  if (/how did you (hear|find)/.test(t)) return "how_heard";

  return "unknown";
}

export interface AnswerLookup {
  category: KnownAnswerCategory;
  value: string | null; // null => no grounded answer, caller must stop
}

// Given a classified category and the sub-field kind (for "identity", which
// specific piece of contact info is being asked for), returns the grounded
// answer from the profile, or null if the profile has nothing for it.
export function lookupAnswer(ctx: FillContext, labelText: string): AnswerLookup {
  const category = classifyField(labelText);
  const t = labelText.toLowerCase();
  const p = ctx.profile;

  switch (category) {
    case "identity": {
      if (/e-?mail/.test(t)) return { category, value: p.email };
      if (/phone|mobile/.test(t)) return { category, value: p.phone };
      if (/preferred name/.test(t)) return { category, value: p.preferredName ?? p.fullName };
      if (/first\s*name/.test(t)) {
        const nameForFirst = p.preferredName ?? p.fullName;
        return { category, value: nameForFirst ? nameForFirst.split(/\s+/)[0] : null };
      }
      if (/last\s*name/.test(t)) {
        if (!p.fullName) return { category, value: null };
        const parts = p.fullName.split(/\s+/);
        return { category, value: parts.length > 1 ? parts[parts.length - 1] : null };
      }
      return { category, value: p.preferredName ?? p.fullName };
    }
    case "address": {
      if (/current location/.test(t)) {
        const location = [p.addressCity, p.addressState].filter(Boolean).join(", ");
        return { category, value: location || null };
      }
      if (/\bzip\b|postal code/.test(t)) return { category, value: p.addressZip };
      if (/\bcity\b/.test(t)) return { category, value: p.addressCity };
      if (/\bstate\b/.test(t)) return { category, value: p.addressState };
      if (/street|address line/.test(t)) return { category, value: p.addressStreet };
      return { category, value: null };
    }
    case "country":
      return { category, value: p.countryOfResidence };
    case "relocation": {
      if (p.willingToRelocate === null || p.willingToRelocate === undefined) return { category, value: null };
      return { category, value: p.willingToRelocate ? "Yes" : "No" };
    }
    case "availability":
      return { category, value: p.internshipTermAvailability };
    case "salary":
      return { category, value: p.salaryAnswerPreference };
    case "links": {
      if (/linkedin/.test(t)) return { category, value: p.linkedin };
      if (/github/.test(t)) return { category, value: p.github };
      return { category, value: p.website };
    }
    case "school":
      return { category, value: p.school };
    case "education":
      return { category, value: ctx.educationDegree ?? null };
    case "experience":
      return { category, value: ctx.recentExperience ?? null };
    case "cover_letter_text":
      return { category, value: ctx.coverLetterText };
    case "work_authorization": {
      if (/sponsorship/.test(t)) {
        if (p.requiresSponsorship === null || p.requiresSponsorship === undefined) return { category, value: null };
        return { category, value: p.requiresSponsorship ? "Yes" : "No" };
      }
      if (/clearance/.test(t)) {
        if (p.clearanceEligible === null || p.clearanceEligible === undefined) return { category, value: null };
        return { category, value: p.clearanceEligible ? "Yes" : "No" };
      }
      if (/eligible to work|authorized to work|legally (able|authorized)/.test(t)) {
        if (!p.workAuthorization) return { category, value: null };
        return { category, value: /not authorized|ineligible/i.test(p.workAuthorization) ? "No" : "Yes" };
      }
      return { category, value: p.workAuthorization };
    }
    case "eeo": {
      if (/gender/.test(t)) return { category, value: p.eeoGender };
      if (/race|ethnicity/.test(t)) return { category, value: p.eeoRaceEthnicity };
      if (/veteran/.test(t)) return { category, value: p.eeoVeteranStatus };
      if (/disabilit/.test(t)) return { category, value: p.eeoDisabilityStatus };
      return { category, value: null };
    }
    case "resume_file":
    case "cover_letter_file":
    case "how_heard":
    case "unknown":
    default:
      return { category, value: null };
  }
}
