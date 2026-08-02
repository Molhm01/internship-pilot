import { describe, expect, it } from "vitest";
import { canonicalizeJobUrl, normalizeForFallbackKey, normalizeLocationKey } from "@/lib/sync/ingest";
import { isEmployerJobUrl } from "@/lib/applications/officialDestination";

describe("normalizeForFallbackKey", () => {
  it("REGRESSION: does not strip 'intern', so an internship cannot merge into the full-time role", () => {
    // The previous implementation stripped /\bintern(ship)?\b/, collapsing
    // these two distinct postings onto one key and silently merging them.
    expect(normalizeForFallbackKey("Software Engineer Intern")).not.toBe(
      normalizeForFallbackKey("Software Engineer"),
    );
    expect(normalizeForFallbackKey("Software Engineering Internship")).not.toBe(
      normalizeForFallbackKey("Software Engineering"),
    );
  });

  it("still ignores punctuation and case drift on the same title", () => {
    expect(normalizeForFallbackKey("Software Engineer, Intern")).toBe(
      normalizeForFallbackKey("software engineer intern"),
    );
  });

  it("keeps genuinely different titles apart", () => {
    expect(normalizeForFallbackKey("Hardware Intern")).not.toBe(normalizeForFallbackKey("Software Intern"));
  });
});

describe("normalizeLocationKey", () => {
  it("treats formatting drift as the same location", () => {
    expect(normalizeLocationKey("New York, NY")).toBe(normalizeLocationKey("new york  ny "));
  });

  it("keeps different cities distinct so one title in two cities stays two jobs", () => {
    expect(normalizeLocationKey("Austin, TX")).not.toBe(normalizeLocationKey("Boston, MA"));
  });

  it("normalizes null and empty to the same empty key", () => {
    expect(normalizeLocationKey(null)).toBe("");
    expect(normalizeLocationKey("   ")).toBe("");
  });
});

describe("canonicalizeJobUrl", () => {
  it("strips tracking parameters so campaign links do not create duplicates", () => {
    const a = canonicalizeJobUrl("https://boards.greenhouse.io/acme/jobs/123?utm_source=x&gh_src=y");
    const b = canonicalizeJobUrl("https://boards.greenhouse.io/acme/jobs/123");
    expect(a).toBe(b);
  });

  it("ignores www, trailing slash, and fragment differences", () => {
    expect(canonicalizeJobUrl("https://www.jobs.example.com/apply/7/#top")).toBe(
      canonicalizeJobUrl("https://jobs.example.com/apply/7"),
    );
  });

  it("REGRESSION: preserves gh_jid, which identifies the job, while dropping gh_src", () => {
    // A `gh_` prefix rule stripped gh_jid too, collapsing every posting on an
    // employer-hosted Greenhouse board (waymo.com/careers/?gh_jid=N) into one
    // URL — 392 distinct Waymo jobs became a single record.
    const a = canonicalizeJobUrl("https://waymo.com/careers/?gh_jid=111&gh_src=abc");
    const b = canonicalizeJobUrl("https://waymo.com/careers/?gh_jid=222&gh_src=abc");
    expect(a).not.toBe(b);
    expect(a).toContain("gh_jid=111");
    expect(a).not.toContain("gh_src");
  });

  it("preserves an unknown parameter rather than assuming it is tracking", () => {
    const a = canonicalizeJobUrl("https://jobs.example.com/apply?postingId=1");
    const b = canonicalizeJobUrl("https://jobs.example.com/apply?postingId=2");
    expect(a).not.toBe(b);
  });

  it("keeps meaningful query parameters", () => {
    const a = canonicalizeJobUrl("https://jobs.example.com/apply?req=1001");
    const b = canonicalizeJobUrl("https://jobs.example.com/apply?req=1002");
    expect(a).not.toBe(b);
  });

  it("keeps different postings apart", () => {
    expect(canonicalizeJobUrl("https://boards.greenhouse.io/acme/jobs/1")).not.toBe(
      canonicalizeJobUrl("https://boards.greenhouse.io/acme/jobs/2"),
    );
  });

  it("returns null for empty input and does not throw on malformed URLs", () => {
    expect(canonicalizeJobUrl(null)).toBeNull();
    expect(canonicalizeJobUrl("")).toBeNull();
    expect(canonicalizeJobUrl("not a url")).toBe("not a url");
  });
});

describe("employer-hosted ATS board URLs are valid official destinations", () => {
  it("REGRESSION: a gh_jid careers URL is job-specific, not a landing page", () => {
    // These left real internships (Motional, Nuro, CannonDesign) with
    // resolutionStatus OFFICIAL_URL_UNRESOLVED and no application URL.
    expect(isEmployerJobUrl("https://motional.com/open-positions/?gh_jid=6659639003")).toBe(true);
    expect(isEmployerJobUrl("https://www.cannondesign.com/careers/?gh_jid=8568074002")).toBe(true);
    expect(isEmployerJobUrl("https://nuro.ai/careersitem?gh_jid=7351061")).toBe(true);
  });

  it("still rejects a bare careers landing page with no job identity", () => {
    expect(isEmployerJobUrl("https://motional.com/open-positions/")).toBe(false);
    expect(isEmployerJobUrl("https://www.cannondesign.com/careers/")).toBe(false);
  });

  it("still rejects a search page", () => {
    expect(isEmployerJobUrl("https://example.com/job-search?q=intern")).toBe(false);
  });
});
