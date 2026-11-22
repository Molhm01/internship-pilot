import { describe, expect, it } from "vitest";
import {
  computeActiveFeed,
  isWithinActiveFreshnessWindow,
  MAX_ACTIVE_FEED_AGE_DAYS,
} from "@/lib/jobs/sourcePolicy";

describe("active-feed 7-day freshness cutoff", () => {
  const now = new Date("2026-08-24T12:00:00.000Z");

  it("keeps postings within 7 days in the active feed", () => {
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    expect(
      isWithinActiveFreshnessWindow(
        { source: "greenhouse", sourcePostedAt: threeDaysAgo, createdAt: threeDaysAgo },
        MAX_ACTIVE_FEED_AGE_DAYS,
        now,
      ),
    ).toBe(true);

    expect(
      computeActiveFeed({
        source: "greenhouse",
        verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
        company: "Acme Systems",
        sourcePostedAt: threeDaysAgo,
        createdAt: threeDaysAgo,
        now,
      }),
    ).toBe(true);
  });

  it("excludes weeks-old postings (> 7 days) from the active feed", () => {
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    expect(
      isWithinActiveFreshnessWindow(
        { source: "greenhouse", sourcePostedAt: fourteenDaysAgo, createdAt: now },
        MAX_ACTIVE_FEED_AGE_DAYS,
        now,
      ),
    ).toBe(false);

    expect(
      computeActiveFeed({
        source: "greenhouse",
        verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
        company: "Acme Systems",
        sourcePostedAt: fourteenDaysAgo,
        createdAt: now,
        now,
      }),
    ).toBe(false);
  });

  it("excludes stale undated non-manual postings older than 14 days", () => {
    const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);
    expect(
      computeActiveFeed({
        source: "lever",
        verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
        company: "Acme Systems",
        sourcePostedAt: null,
        createdAt: twentyDaysAgo,
        now,
      }),
    ).toBe(false);
  });

  it("keeps manual entries active regardless of age", () => {
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(
      computeActiveFeed({
        source: "manual",
        verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
        company: "Acme Systems",
        sourcePostedAt: thirtyDaysAgo,
        createdAt: thirtyDaysAgo,
        now,
      }),
    ).toBe(true);
  });
});
