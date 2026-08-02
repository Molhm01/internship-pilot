import { describe, expect, it } from "vitest";
import { formatSourceAge, postedLabel } from "./postedAge";

const NOW = new Date("2026-08-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("the UI shows source age derived from sourcePostedAt", () => {
  it.each([
    [38 * MINUTE, "Posted 38 minutes ago"],
    [46 * MINUTE, "Posted 46 minutes ago"],
    [HOUR, "Posted 1 hour ago"],
    [4 * HOUR, "Posted 4 hours ago"],
    [DAY, "Posted 1 day ago"],
    [8 * DAY, "Posted 1 week ago"],
    [15 * DAY, "Posted 2 weeks ago"],
    [26 * DAY, "Posted 3 weeks ago"],
    [45 * DAY, "Posted 1 month ago"],
    [90 * DAY, "Posted 3 months ago"],
  ])("renders %ims as %s", (elapsed, expected) => {
    expect(postedLabel({ sourcePostedAt: ago(elapsed) }, NOW).text).toBe(expected);
  });

  it("reads sourcePostedAt, not the local row timestamps", () => {
    const label = postedLabel(
      { sourcePostedAt: ago(38 * MINUTE), postingDate: ago(120 * DAY) },
      NOW,
    );
    expect(label.text).toBe("Posted 38 minutes ago");
    expect(label.unknown).toBe(false);
  });

  it("recomputes the displayed age without the stored instant changing", () => {
    const stored = ago(38 * MINUTE);
    expect(postedLabel({ sourcePostedAt: stored }, NOW).text).toBe("Posted 38 minutes ago");
    const laterView = new Date(NOW.getTime() + 30 * MINUTE);
    expect(postedLabel({ sourcePostedAt: stored }, laterView).text).toBe("Posted 1 hour ago");
    // The value handed to the formatter is untouched — display only.
    expect(stored).toBe(ago(38 * MINUTE));
  });

  it("falls back to the legacy postingDate for pre-backfill rows", () => {
    expect(postedLabel({ sourcePostedAt: null, postingDate: ago(2 * HOUR) }, NOW).text)
      .toBe("Posted 2 hours ago");
  });

  it("labels an unknown date clearly rather than pretending the job is new", () => {
    const label = postedLabel({ sourcePostedAt: null, postingDate: null }, NOW);
    expect(label.unknown).toBe(true);
    expect(label.text).toBe("Posting date unknown");
    expect(label.text).not.toMatch(/today|just now|minute/i);
  });

  it("shows the source's own wording when the date could not be parsed", () => {
    const label = postedLabel(
      { sourcePostedAt: null, sourcePostedText: "Open until filled" },
      NOW,
    );
    expect(label.unknown).toBe(true);
    expect(label.text).toContain("Open until filled");
  });

  it("never renders a future source timestamp as negative time", () => {
    const future = new Date(NOW.getTime() + 5 * MINUTE).toISOString();
    expect(formatSourceAge(future, NOW)).toBe("just now");
  });

  it("returns null for missing or unparseable input", () => {
    expect(formatSourceAge(null, NOW)).toBeNull();
    expect(formatSourceAge("not a date", NOW)).toBeNull();
  });
});
