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
  if (/country code|phone code|dialing code/.test(t)) return "identity";
  if (/country( of (residence|domicile))?|where do you (currently )?(live|reside)/.test(t)) return "country";

  if (/\bpronoun/.test(t)) return "eeo";
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
  if (/\bgpa\b|grade point|\bmajor\b|\bminor\b|field of study|concentration|discipline|graduation|expected grad|education level|degree/.test(t)) {
    return "education";
  }
  if (/most recent (role|experience|position)|current role|recent experience/.test(t)) return "experience";

  if (/e-?mail/.test(t)) return "identity";
  if (/phone|mobile/.test(t)) return "identity";
  if (/middle\s*name|first\s*name|last\s*name|preferred\s*name|full\s*name|your\s*name|^name$|legal name/.test(t)) return "identity";

  if (/street address|address line|\bapt\b|suite|unit\b|\bzip\b|postal code|\bcity\b|\bstate\b(?!ment)|current location|metro area|\b(?:home|mailing|permanent|current|street|full|residential)?\s*address\b/.test(t)) return "address";
  if (/willing(ness)? to relocate|open to relocat|remote preference|work setting/.test(t)) return "relocation";
  if (/available (to start|start date)|earliest start|start date|internship term|when (can|are) you (start|available)/.test(t)) return "availability";
  if (/salary expect|desired (salary|pay|compensation)|compensation expect/.test(t)) return "salary";

  if (/driver'?s?\s*licen[cs]e|at least 18|minimum age|legal working age/.test(t)) return "work_authorization";
  if (/how did you (hear|find)|referral source/.test(t)) return "how_heard";

  return "unknown";
}

export interface AnswerLookup {
  category: KnownAnswerCategory;
  value: string | null; // null => no grounded answer, caller must stop
}

function formatGraduationParts(graduationDate: string | null | undefined, t: string): string | null {
  if (!graduationDate) return null;
  const trimmed = graduationDate.trim();
  const m = trimmed.match(/^(\d{4})(?:-(\d{2}))?$/);
  if (/graduat.*year|expected year/.test(t) && m) return m[1];
  if (/graduat.*month|expected month/.test(t) && m && m[2]) return m[2];
  return trimmed;
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
      if (/alternate|secondary/.test(t) && /e-?mail/.test(t)) return { category, value: p.alternateEmail ?? null };
      if (/e-?mail/.test(t)) return { category, value: p.email };
      if (/country code|phone code|dialing code/.test(t)) return { category, value: p.phoneCountryCode ?? "+1" };
      if (/phone|mobile/.test(t)) return { category, value: p.phone };
      if (/no middle name|do not have a middle name/.test(t)) {
        if (p.noMiddleName === true) return { category, value: "Yes" };
        if (p.legalMiddleName) return { category, value: "No" };
        return { category, value: null };
      }
      if (/middle\s*name/.test(t)) return { category, value: p.legalMiddleName ?? (p.noMiddleName ? "N/A" : null) };
      if (/preferred name/.test(t)) return { category, value: p.preferredName ?? p.fullName };
      if (/first\s*name/.test(t)) {
        if (p.legalFirstName && /legal/.test(t)) return { category, value: p.legalFirstName };
        const nameForFirst = p.legalFirstName ?? p.preferredName ?? p.fullName;
        return { category, value: nameForFirst ? nameForFirst.split(/\s+/)[0] : null };
      }
      if (/last\s*name/.test(t)) {
        if (p.legalLastName) return { category, value: p.legalLastName };
        if (!p.fullName) return { category, value: null };
        const parts = p.fullName.split(/\s+/);
        return { category, value: parts.length > 1 ? parts[parts.length - 1] : null };
      }
      return { category, value: p.preferredName ?? p.fullName };
    }
    case "address": {
      if (/address line 2|\bapt\b|suite|unit\b/.test(t)) return { category, value: p.addressLine2 ?? null };
      if (/metro/.test(t)) return { category, value: p.metroRegion ?? p.addressCity };
      if (/location/.test(t)) {
        const location = [p.addressCity, p.addressState, p.countryOfResidence ?? "United States"].filter(Boolean).join(", ");
        return { category, value: location || "Clifton, NJ, United States" };
      }
      if (/\bzip\b|postal code/.test(t)) return { category, value: p.addressZip };
      if (/\bcity\b/.test(t)) return { category, value: p.addressCity };
      if (/\bstate\b/.test(t)) return { category, value: p.addressState };
      if (/street|address line/.test(t)) return { category, value: p.addressStreet };
      const fullAddress = [
        p.addressStreet,
        p.addressCity,
        [p.addressState, p.addressZip].filter(Boolean).join(" "),
      ]
        .filter(Boolean)
        .join(", ");
      return { category, value: fullAddress || null };
    }
    case "country":
      return { category, value: p.countryOfResidence };
    case "relocation": {
      if (/remote preference|work setting/.test(t)) return { category, value: p.remotePreference ?? null };
      if (p.willingToRelocate === null || p.willingToRelocate === undefined) return { category, value: null };
      return { category, value: p.willingToRelocate ? "Yes" : "No" };
    }
    case "availability":
      if (/earliest start|start date/.test(t)) {
        return { category, value: p.earliestStartDate ?? p.internshipTermAvailability };
      }
      return { category, value: p.internshipTermAvailability ?? p.earliestStartDate ?? null };
    case "salary":
      return { category, value: p.salaryAnswerPreference };
    case "links": {
      if (/linkedin/.test(t)) return { category, value: p.linkedin };
      if (/github/.test(t)) return { category, value: p.github };
      if (/portfolio/.test(t)) return { category, value: p.portfolio ?? p.website };
      return { category, value: p.website ?? p.portfolio ?? p.github ?? p.linkedin };
    }
    case "school":
      if (/previous|prior|former|transfer/.test(t)) return { category, value: p.previousSchool ?? null };
      return { category, value: p.school };
    case "education": {
      if (/\bgpa\b|grade point/.test(t)) return { category, value: p.gpa ?? null };
      if (/start\s*(?:date\s*)?year/.test(t)) return { category, value: "2026" };
      if (/start\s*(?:date\s*)?month/.test(t)) return { category, value: "September" };
      if (/end\s*(?:date\s*)?year/.test(t)) return { category, value: formatGraduationParts(p.graduationDate, "graduation year") ?? "2029" };
      if (/end\s*(?:date\s*)?month/.test(t)) return { category, value: "May" };
      if (/graduation|expected grad|when do you graduate/.test(t)) {
        if (/month\s+and\s+year|mm\/yyyy/i.test(t)) return { category, value: "May 2029" };
        return { category, value: formatGraduationParts(p.graduationDate, t) };
      }
      if (/\bminor\b/.test(t)) return { category, value: p.minor ?? null };
      if (/\bmajor\b|field of study|concentration|discipline/.test(t)) {
        return { category, value: p.major ?? ctx.educationDegree ?? null };
      }
      if (/education level/.test(t)) return { category, value: p.educationLevel ?? p.degreeType ?? ctx.educationDegree ?? null };
      return { category, value: p.degreeType ?? ctx.educationDegree ?? null };
    }
    case "experience":
      return { category, value: ctx.recentExperience ?? null };
    case "cover_letter_text":
      return { category, value: ctx.coverLetterText };
    case "work_authorization": {
      if (/driver'?s?\s*licen[cs]e/.test(t)) {
        if (p.hasDriversLicense === null || p.hasDriversLicense === undefined) return { category, value: null };
        return { category, value: p.hasDriversLicense ? "Yes" : "No" };
      }
      if (/at least 18|minimum age|legal working age/.test(t)) {
        if (p.meetsMinimumAge === null || p.meetsMinimumAge === undefined) return { category, value: null };
        return { category, value: p.meetsMinimumAge ? "Yes" : "No" };
      }
      if (/sponsorship/.test(t)) {
        if (p.requiresSponsorship === null || p.requiresSponsorship === undefined) return { category, value: null };
        return { category, value: p.requiresSponsorship ? "Yes" : "No" };
      }
      if (/clearance/.test(t)) {
        if (p.securityClearanceStatus) return { category, value: p.securityClearanceStatus };
        if (p.clearanceEligible === null || p.clearanceEligible === undefined) return { category, value: null };
        return { category, value: p.clearanceEligible ? "Yes" : "No" };
      }
      if (/\bcitizen(ship)?\b/.test(t)) {
        if (!p.workAuthorization) return { category, value: null };
        return { category, value: /u\.?s\.?\s*citizen/i.test(p.workAuthorization) ? "Yes" : "No" };
      }
      if (/eligible to work|authorized to work|legally (able|authorized)/.test(t)) {
        if (!p.workAuthorization) return { category, value: null };
        return { category, value: /not authorized|ineligible/i.test(p.workAuthorization) ? "No" : "Yes" };
      }
      return { category, value: p.workAuthorization };
    }
    case "eeo": {
      if (/\bpronoun/.test(t)) return { category, value: p.pronouns ?? null };
      if (/gender|\bsex\b/.test(t)) return { category, value: p.eeoGender };
      if (/hispanic|latino|latina|latinx/.test(t)) return { category, value: "Decline to self-identify" };
      if (/race|ethnicity/.test(t)) return { category, value: p.eeoRaceEthnicity };
      if (/veteran/.test(t)) return { category, value: p.eeoVeteranStatus };
      if (/disabilit/.test(t)) return { category, value: p.eeoDisabilityStatus };
      return { category, value: null };
    }
    case "how_heard":
      return { category, value: p.referralSource ?? null };
    case "resume_file":
    case "cover_letter_file":
    case "unknown":
    default:
      return { category, value: null };
  }
}
