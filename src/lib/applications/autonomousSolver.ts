import { classifyField, lookupAnswer } from "@/lib/applications/answerBank";
import { normalizeQuestionText } from "@/lib/applications/approvedAnswers";
import type { FillContext } from "@/lib/applications/types";

export interface AutonomousFieldDescriptor {
  type: string;
  tag?: string;
  options?: string[];
  required?: boolean;
}

export interface AutonomousAnswerResult {
  value: string;
  category: string;
}

const TERMS_CONSENT_RE =
  /\b(certify|certification|terms|privacy|agree|acknowledge|consent|attest|policy|truthful|accurate)\b/i;

const OPTION_ALIASES: Array<[RegExp, RegExp]> = [
  [/^(?:united states|us|usa|u\.s\.|u\.s\.a\.)$/i, /^(?:united states(?: of america)?|us|usa|u\.s\.|u\.s\.a\.)$/i],
  [
    /decline|prefer not|do not wish|not to disclose/i,
    /decline|prefer not|do not wish|wish not|not to disclose|opt out/i,
  ],
  [/\b(?:b\.?s\.?|bachelor|undergraduate)\b/i, /\b(?:b\.?s\.?|b\.?a\.?|b\.?e\.?|bachelor|undergraduate)\b/i],
  [/^yes$/i, /^(?:yes|y|true|i agree|agree|authorized|confirm)$/i],
  [/^no$/i, /^(?:no|n|false|not required|do not require)$/i],
  [
    /company career site|career site/i,
    /company|career|website|job board|online|other|linkedin|internet/i,
  ],
];

const US_STATE_NAMES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california",
  co: "colorado", ct: "connecticut", de: "delaware", dc: "district of columbia",
  fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois",
  in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana",
  me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota",
  ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada",
  nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york",
  nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon",
  pa: "pennsylvania", ri: "rhode island", sc: "south carolina", sd: "south dakota",
  tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia",
  wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming",
};

function isPlaceholderOption(optionText: string): boolean {
  const clean = optionText.trim();
  if (!clean) return true;
  return /^(?:select(?:\s+one|\s+an\s+option|\.{3})?|choose(?:\s+one|\.{3})?|--.*--|-+|please select.*|none selected)$/i.test(
    clean,
  );
}

export function pickAutonomousOption<T extends { label: string; value?: string }>(
  preferredValue: string,
  options: Array<string | T>,
  category?: string,
): { label: string; value: string } | null {
  const normalizedOptions = options
    .map((opt) =>
      typeof opt === "string"
        ? { label: opt.trim(), value: opt.trim() }
        : { label: opt.label.trim(), value: (opt.value ?? opt.label).trim() },
    )
    .filter((o) => !isPlaceholderOption(o.label));

  if (normalizedOptions.length === 0) return null;

  const pref = preferredValue.trim();
  const prefLower = pref.toLowerCase();

  // 1. Exact match on label or value
  const exact = normalizedOptions.find(
    (o) => o.label.toLowerCase() === prefLower || o.value.toLowerCase() === prefLower,
  );
  if (exact) return exact;

  // 1a. United States / +1 dialing code special preference (never pick +247 AC or Minor Outlying Islands)
  if (/^(?:united states|us|usa|u\.s\.|u\.s\.a\.|\+1|\+1\s*us)$/i.test(pref)) {
    const plusOneUs = normalizedOptions.find((o) =>
      /^\+1\s*(?:\(?(?:us|usa|united states)\)?)?$/i.test(o.label)
      || /^united states(?:\s+of\s+america)?(?:\s*\(\+?1\)|\s*\+1|\s*\(us\))?$/i.test(o.label),
    );
    if (plusOneUs) return plusOneUs;
    const usClean = normalizedOptions.find(
      (o) =>
        (/\+1\b.*\b(?:us|united states)\b/i.test(o.label) || /^united states\b/i.test(o.label))
        && !/minor|virgin|outlying|territor/i.test(o.label),
    );
    if (usClean) return usClean;
  }

  // 1b. US State abbreviation <-> full name expansion (e.g. "NJ" -> "New Jersey")
  const expandedState = US_STATE_NAMES[prefLower];
  if (expandedState) {
    const stateMatch = normalizedOptions.find(
      (o) => o.label.toLowerCase() === expandedState || o.value.toLowerCase() === expandedState || o.label.toLowerCase().includes(expandedState),
    );
    if (stateMatch) return stateMatch;
  }

  // 1c. Word-boundary prefix match for Yes/No or short answers (e.g. "Yes" -> "Yes, I am authorized...", "No" -> "No - I do not consent")
  if (/^(?:yes|no)$/i.test(pref)) {
    const prefixRe = new RegExp(`^${prefLower}\\b`, "i");
    const prefixed = normalizedOptions.find((o) => prefixRe.test(o.label) || prefixRe.test(o.value));
    if (prefixed) return prefixed;
  }

  // 1d. Year matching for graduation dropdowns (e.g. "2029" -> match option containing 2029, else 2028, else latest future year)
  if (/^20\d{2}$/.test(pref)) {
    const exactYear = normalizedOptions.find((o) => o.label.includes(pref) || o.value.includes(pref));
    if (exactYear) return exactYear;
    const yearMatches = normalizedOptions
      .map((o) => {
        const yrs = o.label.match(/20\d{2}/g);
        const maxYr = yrs ? Math.max(...yrs.map(Number)) : -1;
        return { o, maxYr };
      })
      .filter((x) => x.maxYr > 0)
      .sort((a, b) => Math.abs(a.maxYr - Number(pref)) - Math.abs(b.maxYr - Number(pref)));
    if (yearMatches.length > 0) return yearMatches[0].o;
  }

  // 1e. GPA range matching (e.g. "3.76" -> "3.6 - 4.0" or "3.5 - 4.0")
  if (/^\d\.\d{1,2}$/.test(pref)) {
    const gpaNum = Number(pref);
    const rangeMatch = normalizedOptions.find((o) => {
      const m = o.label.match(/(\d(?:\.\d+)?)\s*(?:-|to|–)\s*(\d(?:\.\d+)?)/i);
      if (!m) return false;
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      return gpaNum >= lo && gpaNum <= hi;
    });
    if (rangeMatch) return rangeMatch;
  }

  // 2. Substring match (prefer shortest matching label so "United States +1" beats longer unrelated matches)
  if (prefLower.length > 0) {
    const partials = normalizedOptions.filter(
      (o) => o.label.toLowerCase().includes(prefLower) || prefLower.includes(o.label.toLowerCase()),
    );
    if (partials.length > 0) {
      partials.sort((a, b) => a.label.length - b.label.length);
      return partials[0];
    }
  }

  // 3. Semantic alias match
  for (const [prefRe, optRe] of OPTION_ALIASES) {
    if (prefRe.test(pref)) {
      const aliased = normalizedOptions.find((o) => optRe.test(o.label) || optRe.test(o.value));
      if (aliased) return aliased;
    }
  }

  // 4. Category smart preference fallback
  if (category === "school") {
    const njit = normalizedOptions.find((o) => /new jersey institute|\bnjit\b/i.test(o.label));
    if (njit) return njit;
    const other = normalizedOptions.find((o) => /not listed|other|my school/i.test(o.label));
    if (other) return other;
  }

  if (category === "education") {
    if (/electrical|computer|engineer/i.test(pref)) {
      const ee = normalizedOptions.find((o) => /electrical engineering/i.test(o.label))
        ?? normalizedOptions.find((o) => /electrical|computer engineering/i.test(o.label))
        ?? normalizedOptions.find((o) => /\bengineering\b/i.test(o.label));
      if (ee) return ee;
    }
    if (/bachelor|b\.?s\.?|undergrad/i.test(pref)) {
      const bs = normalizedOptions.find((o) => /bachelor|b\.?s\.?\b|undergrad/i.test(o.label));
      if (bs) return bs;
    }
  }

  if (category === "eeo") {
    const decline = normalizedOptions.find((o) =>
      /decline|prefer not|do not wish|wish not|not to disclose|i am not a protected veteran/i.test(o.label),
    );
    if (decline) return decline;
  }

  if (category === "how_heard") {
    const career = normalizedOptions.find((o) =>
      /career|company|website|linkedin|job board|other/i.test(o.label),
    );
    if (career) return career;
  }

  return normalizedOptions[0];
}

function findFuzzySavedAnswer(
  savedAnswers: Record<string, string>,
  normLabel: string,
): string | null {
  if (savedAnswers[normLabel]?.trim()) {
    return savedAnswers[normLabel].trim();
  }
  const tokens = normLabel
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !/^(what|your|with|that|this|have|from|please|enter)$/i.test(t));
  if (tokens.length === 0) return null;

  let bestMatch: string | null = null;
  let bestScore = 0;
  for (const [key, val] of Object.entries(savedAnswers)) {
    if (!val?.trim()) continue;
    let hits = 0;
    for (const token of tokens) {
      if (key.includes(token)) hits += 1;
    }
    const minNeeded = tokens.length === 1 ? 1 : 2;
    if (hits >= minNeeded && hits > bestScore) {
      bestScore = hits;
      bestMatch = val.trim();
    }
  }
  return bestMatch;
}

function buildGroundedEssay(ctx: FillContext, label: string): string {
  const t = label.toLowerCase();
  const degree = ctx.educationDegree || ctx.profile.major || "Computer Science & Engineering";
  const experience = ctx.recentExperience || "software & systems engineering projects";
  const coverSnippet = ctx.coverLetterText?.trim();

  if (/why\b|interest|mission|company|role|excited/i.test(t)) {
    return `I am excited to apply for the ${ctx.jobTitle} role at ${ctx.company} because it aligns directly with my background in ${degree} and hands-on experience in ${experience}. I enjoy shipping reliable, measurable engineering work and look forward to contributing quickly to ${ctx.company}'s team.`;
  }

  if (/project|challenge|accomplish|proud|build|technical/i.test(t)) {
    return `In my recent work with ${experience} alongside my ${degree} coursework, I focused on designing, testing, and debugging production-grade systems end-to-end. I apply structured testing and clear documentation so features hold up reliably under real workloads.`;
  }

  if (coverSnippet && coverSnippet.length > 40) {
    return coverSnippet.slice(0, 480);
  }

  return `As a ${degree} candidate with practical experience in ${experience}, I am well prepared to contribute to ${ctx.company} as a ${ctx.jobTitle}.`;
}

export function resolveAutonomousFieldAnswer(
  ctx: FillContext,
  savedAnswers: Record<string, string>,
  label: string,
  field: AutonomousFieldDescriptor,
): AutonomousAnswerResult {
  const normLabel = normalizeQuestionText(label);
  const category = classifyField(label);
  const t = label.toLowerCase();

  // File uploads
  if (field.type === "file" || category === "resume_file" || category === "cover_letter_file") {
    return {
      value:
        category === "cover_letter_file"
          ? "[Attached tailored cover letter PDF]"
          : "[Attached tailored resume PDF]",
      category,
    };
  }

  // Rippling / custom spinbutton date parts (month / day / year placeholders MM / DD / YYYY)
  if (/^(?:date available.*)?\bmonth\b$|^mm$/i.test(t)) {
    return { value: "05", category: "availability" };
  }
  if (/^(?:date available.*)?\bday\b$|^dd$/i.test(t)) {
    return { value: "15", category: "availability" };
  }
  if (/^(?:date available.*)?\byear\b$|^yyyy$/i.test(t)) {
    return { value: "2027", category: "availability" };
  }

  // SMS / text message consent questions -> clean No (or matching option)
  if (/text message|sms\b|receive text/i.test(t)) {
    return { value: "No", category: "unknown" };
  }

  // Negative-affinity compliance/employment/referral questions (regardless of question phrasing or control type)
  if (
    /previously\s+(?:been\s+)?(?:worked|employed|applied)|ever\s+(?:worked|been\s+employed)|former\s+employee|currently\s+employed\s+(?:by|at)|were you referred|referred by a (?:current )?employee|family\s+member|close\s+relative|government\s+official|conflict\s+of\s+interest|non-?compete|convicted\s+of|felony/i.test(
      t,
    )
  ) {
    return { value: "No", category: "unknown" };
  }

  // Terms, privacy, certification, and acknowledgment checkboxes
  if (field.type === "checkbox" && TERMS_CONSENT_RE.test(label)) {
    return { value: "Yes", category };
  }

  // Check explicit approved run answers -> deterministic answerBank -> saved/fuzzy answers
  const explicitApproved = ctx.approvedRunAnswers?.[normLabel];
  if (explicitApproved?.trim()) {
    return { value: explicitApproved.trim(), category };
  }

  const lookup = lookupAnswer(ctx, label);
  if (lookup.value !== null && String(lookup.value).trim() !== "") {
    return { value: String(lookup.value).trim(), category };
  }

  const mergedSaved = { ...savedAnswers, ...(ctx.approvedRunAnswers ?? {}) };
  const saved = findFuzzySavedAnswer(mergedSaved, normLabel);
  if (saved) {
    return { value: saved, category };
  }

  const p = ctx.profile;
  const fallbackFirstName =
    p.legalFirstName || p.preferredName?.split(/\s+/)[0] || p.fullName?.split(/\s+/)[0] || "Applicant";
  const fallbackLastName =
    p.legalLastName ||
    (p.fullName && p.fullName.includes(" ") ? p.fullName.split(/\s+/).slice(1).join(" ") : "Candidate");

  switch (category) {
    case "eeo": {
      if (/\bpronoun/.test(t)) return { value: p.pronouns || "Prefer not to say", category };
      return { value: "Decline to self-identify", category };
    }
    case "work_authorization": {
      if (/sponsorship/.test(t)) {
        return { value: p.requiresSponsorship === true ? "Yes" : "No", category };
      }
      if (/clearance/.test(t)) {
        return { value: p.securityClearanceStatus || (p.clearanceEligible ? "Yes" : "No"), category };
      }
      if (/\bcitizen(ship)?\b/.test(t)) {
        return {
          value: p.workAuthorization && !/citizen/i.test(p.workAuthorization) ? "No" : "Yes",
          category,
        };
      }
      return { value: "Yes", category };
    }
    case "how_heard":
      return { value: p.referralSource || "Company Career Site", category };
    case "salary":
      return {
        value: field.type === "number" ? "0" : p.salaryAnswerPreference || "Negotiable",
        category,
      };
    case "availability":
      return {
        value:
          field.type === "date"
            ? p.earliestStartDate && /^\d{4}-\d{2}-\d{2}$/.test(p.earliestStartDate)
              ? p.earliestStartDate
              : "2027-05-15"
            : p.internshipTermAvailability || p.earliestStartDate || "Summer 2027",
        category,
      };
    case "education": {
      if (/start\s*(?:date\s*)?year/.test(t)) return { value: "2026", category };
      if (/start\s*(?:date\s*)?month/.test(t)) return { value: "September", category };
      if (/end\s*(?:date\s*)?year|graduat.*year|expected year/.test(t)) return { value: "2029", category };
      if (/end\s*(?:date\s*)?month|graduat.*month|expected month/.test(t)) return { value: "May", category };
      if (/when do you graduate|graduat|expected grad/.test(t)) {
        if (field.type === "date") return { value: "2029-05-15", category };
        if (/month\s+and\s+year|mm\/yyyy/i.test(t)) return { value: "May 2029", category };
        return { value: p.graduationDate || "2029", category };
      }
      if (/\bgpa\b|grade point/.test(t)) return { value: p.gpa || "3.76", category };
      if (/\bmajor\b|field of study|concentration|discipline/.test(t)) {
        return { value: p.major || ctx.educationDegree || "Electrical Engineering", category };
      }
      if (/\bminor\b/.test(t)) return { value: p.minor || "None", category };
      if (/highest level of education|program type|education level/.test(t)) {
        return { value: "Bachelor's Degree", category };
      }
      return {
        value: p.degreeType || ctx.educationDegree || p.educationLevel || "Bachelor's Degree",
        category,
      };
    }
    case "school":
      if (/previous|prior|former|transfer/.test(t)) {
        return { value: p.previousSchool || "Stevens Institute of Technology", category };
      }
      return { value: p.school || "New Jersey Institute of Technology", category };
    case "country":
      return { value: p.countryOfResidence || "United States", category };
    case "relocation":
      return { value: "Yes", category };
    case "links":
      return {
        value: p.linkedin || p.github || p.portfolio || p.website || "https://www.linkedin.com/in/molhm-alasri/",
        category,
      };
    case "experience":
      return { value: ctx.recentExperience || "Electrical & Embedded Systems Researcher", category };
    case "cover_letter_text":
      return { value: buildGroundedEssay(ctx, label), category };
    case "identity": {
      if (/e-?mail/.test(t)) return { value: p.email || p.alternateEmail || "mjalasri1@gmail.com", category };
      if (/country code|phone code|dialing code/.test(t)) return { value: p.phoneCountryCode || "+1", category };
      if (/phone|mobile/.test(t)) return { value: p.phone || "9292643117", category };
      if (/middle/.test(t)) return { value: p.legalMiddleName || "", category };
      if (/first/.test(t)) return { value: fallbackFirstName, category };
      if (/last/.test(t)) return { value: fallbackLastName, category };
      return { value: p.preferredName || p.fullName || `${fallbackFirstName} ${fallbackLastName}`, category };
    }
    case "address": {
      if (/line 2|\bapt\b|suite|unit\b/.test(t)) return { value: p.addressLine2 || "", category };
      if (/\bzip\b|postal/.test(t)) return { value: p.addressZip || "07011", category };
      if (/location/.test(t)) {
        const loc = [p.addressCity || "Clifton", p.addressState || "NJ", p.countryOfResidence || "United States"]
          .filter(Boolean)
          .join(", ");
        return { value: loc, category };
      }
      if (/\bcity\b|metro/.test(t)) return { value: p.addressCity || "Clifton", category };
      if (/\bstate\b/.test(t)) return { value: p.addressState || "NJ", category };
      if (/street|address line/.test(t)) return { value: p.addressStreet || "119 E 7th st", category };
      const fullAddress = [p.addressStreet, p.addressCity, [p.addressState, p.addressZip].filter(Boolean).join(" ")]
        .filter(Boolean)
        .join(", ");
      return { value: fullAddress || "119 E 7th st, Clifton, NJ 07011", category };
    }
    default:
      break;
  }

  // Open-ended textareas
  if (field.tag === "textarea" || field.type === "textarea") {
    return { value: buildGroundedEssay(ctx, label), category };
  }

  // Year / month fields that escaped category classification (NEVER return "1" for a year!)
  if (/(?:end|graduat\w*|completion|finish).*\byear\b|\byear\b.*(?:end|graduat)/i.test(t)) {
    return { value: "2029", category: "education" };
  }
  if (/(?:start|begin|enroll).*\byear\b|\byear\b.*(?:start|begin)/i.test(t)) {
    return { value: "2026", category: "education" };
  }
  if (/(?:end|graduat\w*).*\bmonth\b/i.test(t)) {
    return { value: "May", category: "education" };
  }
  if (/(?:start|begin).*\bmonth\b/i.test(t)) {
    return { value: "September", category: "education" };
  }
  if (field.type === "number" && /\byear\b/i.test(t)) {
    return { value: "2029", category: "education" };
  }

  // Specific input types
  if (field.type === "date") return { value: "2027-05-15", category };
  if (field.type === "url") return { value: p.linkedin || p.github || "https://www.linkedin.com/in/molhm-alasri/", category };
  if (field.type === "email") return { value: p.email || "mjalasri1@gmail.com", category };
  if (field.type === "tel") return { value: p.phone || "9292643117", category };
  if (field.type === "number" || /years? of experience|how many years/i.test(t)) {
    return { value: "1", category };
  }
  if (field.type === "checkbox") {
    return { value: "Yes", category };
  }

  // Boolean / yes-no question phrasing (check BEFORE generic option fallback so radio/select gets proper Yes/No)
  if (/^(?:are you|do you|have you|will you|can you|would you|did you|is this)\b/i.test(t)) {
    const negativeCompanyAffinity =
      /previously\s+(?:been\s+)?(?:worked|employed|applied)|family member|relative|require.*sponsorship|need.*sponsorship|non-?compete|convicted/i.test(
        t,
      );
    return { value: negativeCompanyAffinity ? "No" : "Yes", category };
  }

  if (field.options && field.options.length > 0) {
    const picked = pickAutonomousOption("", field.options, category);
    if (picked) return { value: picked.label, category };
  }

  // Short-response links & open-ended text inputs (e.g. Rippling 300-char inputs)
  if (/\b(?:share a link|project link|link to something|work sample)\b/i.test(t)) {
    return { value: p.github || p.portfolio || "https://github.com/Molhm01", category: "links" };
  }
  if (/\b(?:what are you studying|studying,?\s*and\s*why)\b/i.test(t)) {
    return {
      value:
        "I am studying Electrical Engineering at NJIT (B.S., May 2029) after studying Computer Engineering at Stevens (3.76 GPA) because I enjoy building embedded hardware, power/signal circuits, and real-time control systems.",
      category: "education",
    };
  }
  if (/\b(?:what|why|describe|tell us|explain|proud of|created|solved|built|accomplish)\b/i.test(t)) {
    return { value: buildGroundedEssay(ctx, label).slice(0, 260), category: "cover_letter_text" };
  }

  if (/\b(?:company name|current company|employer|organization)\b/i.test(t)) {
    return { value: p.school || "New Jersey Institute of Technology", category };
  }
  if (/\b(?:current title|job title|headline|^title$)\b/i.test(t)) {
    return { value: ctx.recentExperience || "Electrical Engineering Student", category };
  }

  return { value: "N/A", category };
}

export const DEFAULT_PORTAL_EMAIL = "mjalasri1@gmail.com";
export const DEFAULT_PORTAL_PASSWORD = "Molhmiscool21!";

export function generatePortalCredentials(
  email: string | null | undefined,
  _company: string,
  fullName?: string | null,
  preferredPassword?: string | null,
): {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  fullName: string;
} {
  const safeEmail = (email || DEFAULT_PORTAL_EMAIL).trim();
  const password = (preferredPassword && preferredPassword.trim())
    || process.env.PORTAL_ACCOUNT_PASSWORD?.trim()
    || DEFAULT_PORTAL_PASSWORD;
  const parts = (fullName || safeEmail.split("@")[0] || "Molhm Alasri")
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/);
  const firstName = parts[0] || "Molhm";
  const lastName = parts.slice(1).join(" ") || "Alasri";
  return {
    email: safeEmail,
    password,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
  };
}
