// Canonical parsing of a source's posting date into `Job.sourcePostedAt`.
//
// The whole point of this module is that a relative date ("38 minutes ago") is
// only meaningful RELATIVE TO THE MOMENT THE SOURCE WAS READ. So parsing always
// takes an explicit `capturedAt` (the sync's fetch timestamp) and converts once,
// at ingest, into an absolute UTC instant. Nothing downstream ever re-derives it
// — the Jobs page recomputes the *displayed* age from the stored instant, never
// the instant from the displayed age.

/**
 * How much the stored `sourcePostedAt` can be trusted.
 *
 * Ordering matters: a later entry may overwrite an earlier one when the same
 * posting is rediscovered, never the reverse. That is what keeps a rediscovered
 * job from silently drifting to "just posted".
 */
export const SOURCE_DATE_CONFIDENCE = ["UNKNOWN", "DATE_ONLY", "RELATIVE_PARSED", "EXACT"] as const;

export type SourceDateConfidence = (typeof SOURCE_DATE_CONFIDENCE)[number];

// Authority of the source that supplied the timestamp. This is intentionally
// separate from precision: an exact radar timestamp is precise, but an exact
// employer ATS timestamp is both precise and authoritative.
export const SOURCE_DATE_PROVENANCE = [
  "UNKNOWN",
  "INFERRED",
  "TRUSTED_RADAR_RELATIVE",
  "TRUSTED_RADAR_EXACT",
  "EMPLOYER_JSON_LD",
  "EMPLOYER_ATS_DATE",
  "EMPLOYER_ATS_EXACT",
] as const;

export type SourceDateProvenance = (typeof SOURCE_DATE_PROVENANCE)[number];

export function provenanceRank(provenance: string | null | undefined): number {
  const index = SOURCE_DATE_PROVENANCE.indexOf((provenance ?? "UNKNOWN") as SourceDateProvenance);
  return index === -1 ? 0 : index;
}

export function employerAtsProvenance(date: ParsedSourceDate): SourceDateProvenance {
  if (!date.sourcePostedAt) return "UNKNOWN";
  return date.sourceDateConfidence === "EXACT" ? "EMPLOYER_ATS_EXACT" : "EMPLOYER_ATS_DATE";
}

export function trustedRadarProvenance(date: ParsedSourceDate): SourceDateProvenance {
  if (!date.sourcePostedAt) return "UNKNOWN";
  return date.sourceDateConfidence === "EXACT" ? "TRUSTED_RADAR_EXACT" : "TRUSTED_RADAR_RELATIVE";
}

export type ParsedSourceDate = {
  /** Absolute UTC instant, or null when the source gave us nothing usable. */
  sourcePostedAt: Date | null;
  /** The original source text, preserved verbatim when it was text. */
  sourcePostedText: string | null;
  sourceDateConfidence: SourceDateConfidence;
};

export function confidenceRank(confidence: SourceDateConfidence | null | undefined): number {
  const index = SOURCE_DATE_CONFIDENCE.indexOf((confidence ?? "UNKNOWN") as SourceDateConfidence);
  return index === -1 ? 0 : index;
}

const UNPARSED: ParsedSourceDate = {
  sourcePostedAt: null,
  sourcePostedText: null,
  sourceDateConfidence: "UNKNOWN",
};

// Units the aggregators actually emit, in seconds. "month" and "year" are
// approximations by construction — the source itself only claims that much
// precision, and the confidence tag records that.
const UNIT_SECONDS: Record<string, number> = {
  second: 1,
  sec: 1,
  s: 1,
  minute: 60,
  min: 60,
  m: 60,
  hour: 3600,
  hr: 3600,
  h: 3600,
  day: 86_400,
  d: 86_400,
  week: 604_800,
  w: 604_800,
  month: 2_592_000, // 30 days
  mo: 2_592_000,
  year: 31_536_000, // 365 days
  y: 31_536_000,
};

// "Posted 38 minutes ago", "38 minutes ago", "about 1 hour ago", "30+ days ago",
// "3 mo ago". The leading "posted"/"about"/"over" noise and the trailing "ago"
// are both optional so "Posted Today"-style strings still reach the keyword pass.
const RELATIVE_RE =
  /(?:^|\s)(?:about\s+|over\s+|almost\s+|nearly\s+)?(\d+)\s*\+?\s*(second|sec|minute|min|hour|hr|day|week|month|mo|year|s|m|h|d|w|y)s?\.?\s*ago\b/i;

const ISO_WITH_TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const ISO_DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const MONTH_NAME_RE =
  /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function utcDateOnly(year: number, month1: number, day: number): Date | null {
  if (month1 < 1 || month1 > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month1 - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Start of the capture day, in UTC — used for "today"/"yesterday" text. */
function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function fromEpoch(value: number): Date | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  // Sources emit both seconds and milliseconds. Anything below ~1e11 cannot be
  // a plausible millisecond timestamp for a job posting (that is 1973), so it
  // is seconds.
  const ms = value < 1e11 ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Parse whatever a source gave us for "when was this posted" into an absolute
 * instant, using `capturedAt` as the reference point for relative text.
 *
 * Accepts a Date, an epoch number (seconds or milliseconds), or a string in
 * relative ("4 hours ago"), keyword ("today"), ISO, US, or month-name form.
 */
export function parseSourcePostedAt(raw: unknown, capturedAt: Date): ParsedSourceDate {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return UNPARSED;
    // A midnight-UTC instant carries no time-of-day information, so it is
    // date-only precision no matter how it reached us.
    const dateOnly = raw.getTime() % 86_400_000 === 0;
    return {
      sourcePostedAt: raw,
      sourcePostedText: null,
      sourceDateConfidence: dateOnly ? "DATE_ONLY" : "EXACT",
    };
  }

  if (typeof raw === "number") {
    const parsed = fromEpoch(raw);
    return parsed
      ? { sourcePostedAt: parsed, sourcePostedText: null, sourceDateConfidence: "EXACT" }
      : UNPARSED;
  }

  if (typeof raw !== "string") return UNPARSED;

  const text = raw.trim();
  if (!text) return UNPARSED;
  const withText = (sourcePostedAt: Date | null, sourceDateConfidence: SourceDateConfidence) => ({
    sourcePostedAt,
    sourcePostedText: text,
    sourceDateConfidence: sourcePostedAt ? sourceDateConfidence : "UNKNOWN" as const,
  });

  // A bare number in a string is still an epoch value.
  if (/^\d{10,13}$/.test(text)) return withText(fromEpoch(Number(text)), "EXACT");

  // --- relative forms, resolved against the capture time ---
  const relative = RELATIVE_RE.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const seconds = UNIT_SECONDS[relative[2].toLowerCase()];
    if (Number.isFinite(amount) && seconds) {
      return withText(new Date(capturedAt.getTime() - amount * seconds * 1000), "RELATIVE_PARSED");
    }
  }

  const lower = text.toLowerCase();
  if (/\b(just\s+posted|just\s+now|moments?\s+ago|new\s+today)\b/.test(lower)) {
    return withText(new Date(capturedAt.getTime()), "RELATIVE_PARSED");
  }
  if (/\byesterday\b/.test(lower)) {
    return withText(new Date(startOfUtcDay(capturedAt).getTime() - 86_400_000), "DATE_ONLY");
  }
  if (/\btoday\b/.test(lower)) {
    // "Posted Today" claims the day, not the minute — do not pretend it is
    // fresher than a posting with a real timestamp from earlier the same day.
    return withText(startOfUtcDay(capturedAt), "DATE_ONLY");
  }

  // --- absolute forms ---
  if (ISO_WITH_TIME_RE.test(text)) {
    const date = new Date(text.includes("T") ? text : text.replace(" ", "T"));
    if (!Number.isNaN(date.getTime())) return withText(date, "EXACT");
  }

  const iso = ISO_DATE_ONLY_RE.exec(text);
  if (iso) {
    return withText(utcDateOnly(Number(iso[1]), Number(iso[2]), Number(iso[3])), "DATE_ONLY");
  }

  const us = US_DATE_RE.exec(text);
  if (us) {
    return withText(utcDateOnly(Number(us[3]), Number(us[1]), Number(us[2])), "DATE_ONLY");
  }

  const named = MONTH_NAME_RE.exec(text);
  if (named) {
    const month = MONTHS.indexOf(named[1].toLowerCase()) + 1;
    return withText(utcDateOnly(Number(named[3]), month, Number(named[2])), "DATE_ONLY");
  }

  return { ...UNPARSED, sourcePostedText: text };
}

/**
 * Try several candidate values (most authoritative first) and keep the first
 * one that yields an instant, while preserving whichever candidate was the
 * human-readable source text.
 */
export function parseFirstSourceDate(candidates: unknown[], capturedAt: Date): ParsedSourceDate {
  let text: string | null = null;
  for (const candidate of candidates) {
    const parsed = parseSourcePostedAt(candidate, capturedAt);
    text ??= parsed.sourcePostedText;
    if (parsed.sourcePostedAt) {
      return { ...parsed, sourcePostedText: parsed.sourcePostedText ?? text };
    }
  }
  return { sourcePostedAt: null, sourcePostedText: text, sourceDateConfidence: "UNKNOWN" };
}

/**
 * Whether a rediscovery may overwrite the stored posting date.
 *
 * Rule (Phase 2): `sourcePostedAt` is written once and then only replaced when
 * the source provides a STRICTLY more reliable date. Re-parsing the same
 * "3 days ago" text on a later sync would otherwise walk the timestamp forward
 * on every run and make an old posting look new.
 */
export function shouldReplaceSourcePostedAt(
  existing: { sourcePostedAt: Date | null; sourceDateConfidence: string | null } | null | undefined,
  incoming: ParsedSourceDate,
): boolean {
  if (!incoming.sourcePostedAt) return false;
  if (!existing?.sourcePostedAt) return true;
  return (
    confidenceRank(incoming.sourceDateConfidence)
    > confidenceRank(existing.sourceDateConfidence as SourceDateConfidence | null)
  );
}

/**
 * Provenance-aware replacement used by canonical jobs. Source authority wins;
 * precision breaks ties. This encodes the product rule that an employer date
 * outranks a radar timestamp, while unknown dates never replace known ones.
 */
export function shouldReplaceCanonicalSourceDate(
  existing: {
    sourcePostedAt: Date | null;
    sourceDateConfidence: string | null;
    sourceDateProvenance: string | null;
  } | null | undefined,
  incoming: ParsedSourceDate,
  incomingProvenance: SourceDateProvenance,
): boolean {
  if (!incoming.sourcePostedAt) return false;
  if (!existing?.sourcePostedAt) return true;
  const authorityDelta = provenanceRank(incomingProvenance) - provenanceRank(existing.sourceDateProvenance);
  if (authorityDelta !== 0) return authorityDelta > 0;
  return (
    confidenceRank(incoming.sourceDateConfidence)
    > confidenceRank(existing.sourceDateConfidence as SourceDateConfidence | null)
  );
}
