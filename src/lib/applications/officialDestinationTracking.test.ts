import { describe, expect, it } from "vitest";

import { stripTrackingParameters } from "@/lib/applications/officialDestination";

/**
 * Aggregator attribution on an employer's own URL.
 *
 * The match-quality audit found 226 of 1,485 published Apply URLs carrying
 * `?utm_source=Simplify&ref=Simplify`. The destination was the employer's real
 * posting every time — so this was never a wrong-destination bug — but the
 * canonical URL this product calls "the employer's official application page"
 * was stamped with a third party's attribution, and that is what the user's
 * browser would have sent.
 */
describe("tracking parameters on a canonical Apply URL", () => {
  it("removes an aggregator's attribution from the employer's own URL", () => {
    expect(
      stripTrackingParameters(
        "https://flir.wd1.myworkdayjobs.com/flircareers/job/US-Huntsville/Intern_REQ36193?utm_source=Simplify&ref=Simplify",
      ),
    ).toBe("https://flir.wd1.myworkdayjobs.com/flircareers/job/US-Huntsville/Intern_REQ36193");
  });

  it("keeps every parameter the employer's own board needs", () => {
    const url = "https://careers.example.com/apply?jobId=REQ-1&lang=en_US&gh_jid=4001&mode=apply";
    expect(stripTrackingParameters(url)).toBe(url);
  });

  it("only strips ambiguous keys when the value names an aggregator", () => {
    // `src` is a legitimate employer parameter on several boards, so the key
    // alone is not enough to remove it.
    expect(stripTrackingParameters("https://jobs.example.com/x?src=careers-page")).toBe(
      "https://jobs.example.com/x?src=careers-page",
    );
    expect(stripTrackingParameters("https://jobs.example.com/x?src=Simplify")).toBe(
      "https://jobs.example.com/x",
    );
    expect(stripTrackingParameters("https://jobs.example.com/x?ref=jobright")).toBe(
      "https://jobs.example.com/x",
    );
  });

  it("leaves a URL with no query untouched, and never leaves a bare question mark", () => {
    expect(stripTrackingParameters("https://jobs.example.com/x")).toBe("https://jobs.example.com/x");
    expect(stripTrackingParameters("https://jobs.example.com/x?utm_source=Simplify")).toBe(
      "https://jobs.example.com/x",
    );
  });

  it("preserves employer parameters that sit alongside the tracking ones", () => {
    expect(
      stripTrackingParameters("https://jobs.example.com/x?gh_jid=42&utm_source=Simplify&lang=en"),
    ).toBe("https://jobs.example.com/x?gh_jid=42&lang=en");
  });

  it("returns a non-URL string unchanged rather than throwing", () => {
    expect(stripTrackingParameters("not a url")).toBe("not a url");
    expect(stripTrackingParameters("")).toBe("");
  });
});
