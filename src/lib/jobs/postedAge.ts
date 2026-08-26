// How a job's source posting date is rendered on screen.
//
// The stored `sourcePostedAt` is an absolute instant and is never rewritten by
// display code. Only the human-readable AGE is recomputed, here, at render
// time — so a card that said "38 minutes ago" an hour ago says "1 hour ago"
// now without a single database write.

export type PostedAgeSource = {
  sourcePostedAt?: string | Date | null;
  sourcePostedText?: string | null;
  sourceDateConfidence?: string | null;
  /** Legacy fallback for rows ingested before sourcePostedAt existed. */
  postingDate?: string | Date | null;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/**
 * Format the elapsed time since an instant, down to minute resolution.
 *
 * Minute and hour resolution is the entire point: the source shows internships
 * posted "38 minutes ago", and collapsing everything under a day to "today"
 * made a genuinely fresh feed look stale.
 */
export function formatSourceAge(
  value: string | Date | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(ms)) return null;

  const elapsed = now.getTime() - ms;
  // A source clock slightly ahead of ours is normal; never render "in 2 minutes".
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), "minute");
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), "hour");
  if (elapsed < WEEK) return plural(Math.floor(elapsed / DAY), "day");
  if (elapsed < MONTH) return plural(Math.floor(elapsed / WEEK), "week");
  if (elapsed < YEAR) return plural(Math.floor(elapsed / MONTH), "month");
  return plural(Math.floor(elapsed / YEAR), "year");
}

export type PostedLabel = {
  /** What the card shows, e.g. "Posted 38 minutes ago". */
  text: string;
  /** True when no reliable source date exists — shown as unknown, not as new. */
  unknown: boolean;
  /** Tooltip: the exact stored instant, or the source's original wording. */
  title?: string;
};

/**
 * The posting-age line for a job card.
 *
 * An unknown date is labelled as unknown. It is never silently rendered as
 * "today" or backfilled from a local timestamp, because that is exactly how a
 * stale record ends up looking like a fresh one.
 */
export function postedLabel(job: PostedAgeSource, now: Date = new Date()): PostedLabel {
  const posted = job.sourcePostedAt === undefined
    ? job.postingDate ?? null
    : job.sourcePostedAt;
  const age = formatSourceAge(posted, now);

  if (!age) {
    return {
      text: job.sourcePostedText
        ? `Posting date unknown (source said "${job.sourcePostedText}")`
        : "Posting date unavailable",
      unknown: true,
    };
  }

  const exact = posted instanceof Date ? posted : new Date(posted as string);
  const title = job.sourceDateConfidence === "DATE_ONLY"
    ? `Source gave a date without a time: ${exact.toISOString().slice(0, 10)}`
    : `Source posting date: ${exact.toISOString()}`;

  return { text: `Posted ${age}`, unknown: false, title };
}
