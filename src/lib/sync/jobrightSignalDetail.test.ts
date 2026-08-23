// Gate 3 (part) — direct official-destination extraction from the discovery
// feed's own metadata, and the freshness rules around it.
//
// The fixture below mirrors the real shape observed on jobright.ai/jobs/info/<id>
// on 2026-08-22: no employer job URL anywhere in the payload, but the company's
// own website published as `companyResult.companyURL`, and a `publishTime`
// written in a local zone seven hours ahead of the same posting's epoch.

import { describe, expect, it } from "vitest";
import {
  EMPTY_SIGNAL_DETAIL,
  jobrightDetailUrl,
  parseJobrightSignalDetail,
} from "@/lib/sync/jobrightSignalDetail";
import { parseFirstSourceDate } from "@/lib/sync/sourceDate";

function detailPage(payload: Record<string, unknown>, extraHtml = ""): string {
  return `<!doctype html><html><body>${extraHtml}<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    payload,
  )}</script></body></html>`;
}

const REAL_SHAPE = detailPage({
  props: {
    pageProps: {
      dataSource: {
        jobResult: {
          jobId: "6a8a1d104afae74a0834f7dd",
          jobTitle: "Formal Verification Intern",
          publishTime: "2026-08-22 22:05:04",
          publishTimeDesc: "2 hours ago",
          isDeleted: false,
          isCompanySiteLink: true,
        },
        companyResult: {
          companyURL: "http://tenstorrent.com",
          companyLinkedinURL: "https://www.linkedin.com/company/10629072",
          companyTwitterURL: "https://x.com/tenstorrent",
        },
      },
      pageUrl: "https://jobright.ai/jobs/info/6a8a1d104afae74a0834f7dd",
    },
  },
});

describe("Jobright detail enrichment", () => {
  it("recovers the employer's own domain, which the list payload never carries", () => {
    const detail = parseJobrightSignalDetail(REAL_SHAPE, jobrightDetailUrl("6a8a1d104afae74a0834f7dd"));
    expect(detail.companyDomain).toBe("tenstorrent.com");
  });

  it("keeps the source's relative wording without trusting its wall-clock string", () => {
    const detail = parseJobrightSignalDetail(REAL_SHAPE, jobrightDetailUrl("x"));
    expect(detail.postedText).toBe("2 hours ago");
    // publishTime ("2026-08-22 22:05:04") is 7 hours ahead of the same posting's
    // epoch (2026-08-22T15:05:04Z). Reading it as UTC would move every posting
    // into the future, so it is deliberately not extracted at all.
    expect(JSON.stringify(detail)).not.toContain("22:05:04");
  });

  it("does not invent an employer destination when the source states none", () => {
    const detail = parseJobrightSignalDetail(REAL_SHAPE, jobrightDetailUrl("x"));
    expect(detail.originalJobPostUrl).toBeNull();
  });

  it("accepts an employer destination when the source does state one", () => {
    const page = detailPage(
      { props: { pageProps: { dataSource: { jobResult: {}, companyResult: {} } } } },
      '<a href="https://boards.greenhouse.io/tenstorrent/jobs/777">Original Job Post</a>',
    );
    expect(parseJobrightSignalDetail(page, jobrightDetailUrl("x")).originalJobPostUrl).toBe(
      "https://boards.greenhouse.io/tenstorrent/jobs/777",
    );
  });

  it("REGRESSION: refuses an aggregator link labelled as the original post", () => {
    const page = detailPage(
      { props: { pageProps: {} } },
      '<a href="https://www.linkedin.com/jobs/view/999">Original Job Post</a>',
    );
    expect(parseJobrightSignalDetail(page, jobrightDetailUrl("x")).originalJobPostUrl).toBeNull();
  });

  it("reports an explicitly removed posting", () => {
    const page = detailPage({
      props: { pageProps: { dataSource: { jobResult: { isDeleted: true }, companyResult: {} } } },
    });
    expect(parseJobrightSignalDetail(page, jobrightDetailUrl("x")).removedAtSource).toBe(true);
  });

  it("degrades to empty rather than throwing on unusable markup", () => {
    expect(parseJobrightSignalDetail("<html>not a next app</html>", jobrightDetailUrl("x"))).toEqual(
      EMPTY_SIGNAL_DETAIL,
    );
  });
});

describe("Gate 3 — relative posting dates resolve against the capture instant", () => {
  const capturedAt = new Date("2026-08-22T17:05:04.000Z");

  it("parses the wordings these feeds actually emit", () => {
    const cases: [string, string][] = [
      ["20 minutes ago", "2026-08-22T16:45:04.000Z"],
      ["3 hours ago", "2026-08-22T14:05:04.000Z"],
      ["1 day ago", "2026-08-21T17:05:04.000Z"],
      ["2 days ago", "2026-08-20T17:05:04.000Z"],
    ];
    for (const [text, expected] of cases) {
      const parsed = parseFirstSourceDate([text], capturedAt);
      expect(parsed.sourcePostedAt?.toISOString(), text).toBe(expected);
      expect(parsed.sourceDateConfidence).toBe("RELATIVE_PARSED");
    }
  });

  it("resolves 'today' to the capture day rather than to the render time", () => {
    const parsed = parseFirstSourceDate(["today"], capturedAt);
    expect(parsed.sourcePostedAt?.toISOString().slice(0, 10)).toBe("2026-08-22");
  });

  it("marks a date with no usable value as UNKNOWN so it sorts last", () => {
    const parsed = parseFirstSourceDate([null, undefined, ""], capturedAt);
    expect(parsed.sourcePostedAt).toBeNull();
    expect(parsed.sourceDateConfidence).toBe("UNKNOWN");
  });

  it("prefers an exact epoch over relative wording for the same posting", () => {
    const parsed = parseFirstSourceDate([1787411104000, "2 hours ago"], capturedAt);
    expect(parsed.sourcePostedAt?.toISOString()).toBe("2026-08-22T15:05:04.000Z");
    expect(parsed.sourceDateConfidence).toBe("EXACT");
  });
});
