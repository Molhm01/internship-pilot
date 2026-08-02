import { describe, expect, it } from "vitest";
import {
  parseFirstSourceDate,
  parseSourcePostedAt,
  shouldReplaceSourcePostedAt,
} from "./sourceDate";

// The sync read the source at this instant. Every relative date below must be
// resolved against IT, not against the moment the test happens to run.
const CAPTURED_AT = new Date("2026-08-01T12:00:00.000Z");

describe("relative source dates are parsed using the sync capture time", () => {
  it.each([
    ["38 minutes ago", "2026-08-01T11:22:00.000Z"],
    ["46 minutes ago", "2026-08-01T11:14:00.000Z"],
    ["1 hour ago", "2026-08-01T11:00:00.000Z"],
    ["4 hours ago", "2026-08-01T08:00:00.000Z"],
    ["8 days ago", "2026-07-24T12:00:00.000Z"],
    ["2 weeks ago", "2026-07-18T12:00:00.000Z"],
    ["3 months ago", "2026-05-03T12:00:00.000Z"],
  ])("parses %s", (text, expected) => {
    const parsed = parseSourcePostedAt(text, CAPTURED_AT);
    expect(parsed.sourcePostedAt?.toISOString()).toBe(expected);
    expect(parsed.sourceDateConfidence).toBe("RELATIVE_PARSED");
    expect(parsed.sourcePostedText).toBe(text);
  });

  it("accepts the source's decorated wording", () => {
    expect(parseSourcePostedAt("Posted 38 minutes ago", CAPTURED_AT).sourcePostedAt?.toISOString())
      .toBe("2026-08-01T11:22:00.000Z");
    expect(parseSourcePostedAt("about 1 hour ago", CAPTURED_AT).sourcePostedAt?.toISOString())
      .toBe("2026-08-01T11:00:00.000Z");
    expect(parseSourcePostedAt("Posted 30+ Days Ago", CAPTURED_AT).sourcePostedAt?.toISOString())
      .toBe("2026-07-02T12:00:00.000Z");
  });

  it("never resolves a relative date against the current clock", () => {
    const older = parseSourcePostedAt("1 hour ago", new Date("2026-07-01T12:00:00.000Z"));
    expect(older.sourcePostedAt?.toISOString()).toBe("2026-07-01T11:00:00.000Z");
  });

  it("treats 'Posted Today' as a day, not as this instant", () => {
    const parsed = parseSourcePostedAt("Posted Today", CAPTURED_AT);
    expect(parsed.sourcePostedAt?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(parsed.sourceDateConfidence).toBe("DATE_ONLY");
  });
});

describe("absolute source dates are parsed correctly", () => {
  it("reads epoch milliseconds as an exact instant", () => {
    const parsed = parseSourcePostedAt(Date.UTC(2026, 6, 31, 22, 40, 0), CAPTURED_AT);
    expect(parsed.sourcePostedAt?.toISOString()).toBe("2026-07-31T22:40:00.000Z");
    expect(parsed.sourceDateConfidence).toBe("EXACT");
  });

  it("reads epoch seconds as an exact instant", () => {
    const parsed = parseSourcePostedAt(Math.floor(Date.UTC(2026, 6, 31, 22, 40, 0) / 1000), CAPTURED_AT);
    expect(parsed.sourcePostedAt?.toISOString()).toBe("2026-07-31T22:40:00.000Z");
  });

  it("reads an ISO timestamp as an exact instant and stores it in UTC", () => {
    const parsed = parseSourcePostedAt("2026-07-31T18:30:00-04:00", CAPTURED_AT);
    expect(parsed.sourcePostedAt?.toISOString()).toBe("2026-07-31T22:30:00.000Z");
    expect(parsed.sourceDateConfidence).toBe("EXACT");
  });

  it.each([
    ["2026-07-31", "2026-07-31T00:00:00.000Z"],
    ["07/31/2026", "2026-07-31T00:00:00.000Z"],
    ["July 31, 2026", "2026-07-31T00:00:00.000Z"],
    ["Jul 31 2026", "2026-07-31T00:00:00.000Z"],
  ])("reads %s as a date-only value", (text, expected) => {
    const parsed = parseSourcePostedAt(text, CAPTURED_AT);
    expect(parsed.sourcePostedAt?.toISOString()).toBe(expected);
    expect(parsed.sourceDateConfidence).toBe("DATE_ONLY");
  });

  it("marks unusable text as UNKNOWN while preserving the original wording", () => {
    const parsed = parseSourcePostedAt("Rolling / open until filled", CAPTURED_AT);
    expect(parsed.sourcePostedAt).toBeNull();
    expect(parsed.sourceDateConfidence).toBe("UNKNOWN");
    expect(parsed.sourcePostedText).toBe("Rolling / open until filled");
  });

  it("returns UNKNOWN when the source gave nothing at all", () => {
    expect(parseSourcePostedAt(null, CAPTURED_AT).sourceDateConfidence).toBe("UNKNOWN");
    expect(parseSourcePostedAt(undefined, CAPTURED_AT).sourcePostedAt).toBeNull();
    expect(parseSourcePostedAt("", CAPTURED_AT).sourcePostedAt).toBeNull();
  });
});

describe("parseFirstSourceDate", () => {
  it("prefers the first candidate that yields an instant", () => {
    const parsed = parseFirstSourceDate([null, "not a date", "2 hours ago"], CAPTURED_AT);
    expect(parsed.sourcePostedAt?.toISOString()).toBe("2026-08-01T10:00:00.000Z");
  });

  it("keeps the source's own wording even when no candidate parses", () => {
    const parsed = parseFirstSourceDate([null, "whenever"], CAPTURED_AT);
    expect(parsed.sourcePostedAt).toBeNull();
    expect(parsed.sourcePostedText).toBe("whenever");
  });
});

describe("sourcePostedAt stability across syncs", () => {
  const existing = {
    sourcePostedAt: new Date("2026-05-01T00:00:00.000Z"),
    sourceDateConfidence: "RELATIVE_PARSED",
  };

  it("does not replace a stored date when the same relative text is re-read later", () => {
    const reread = parseSourcePostedAt("3 months ago", new Date("2026-09-01T12:00:00.000Z"));
    expect(shouldReplaceSourcePostedAt(existing, reread)).toBe(false);
  });

  it("replaces a stored date only when the source becomes strictly more reliable", () => {
    const exact = parseSourcePostedAt("2026-05-01T09:15:00.000Z", CAPTURED_AT);
    expect(shouldReplaceSourcePostedAt(existing, exact)).toBe(true);
  });

  it("does not downgrade an exact date to a parsed relative one", () => {
    const exactExisting = { sourcePostedAt: new Date("2026-05-01T09:15:00.000Z"), sourceDateConfidence: "EXACT" };
    const relative = parseSourcePostedAt("2 days ago", CAPTURED_AT);
    expect(shouldReplaceSourcePostedAt(exactExisting, relative)).toBe(false);
  });

  it("fills in a date for a record that never had one", () => {
    const relative = parseSourcePostedAt("2 days ago", CAPTURED_AT);
    expect(shouldReplaceSourcePostedAt({ sourcePostedAt: null, sourceDateConfidence: "UNKNOWN" }, relative)).toBe(true);
    expect(shouldReplaceSourcePostedAt(null, relative)).toBe(true);
  });

  it("never clears a stored date because the newest sighting has none", () => {
    const nothing = parseSourcePostedAt(null, CAPTURED_AT);
    expect(shouldReplaceSourcePostedAt(existing, nothing)).toBe(false);
  });
});
