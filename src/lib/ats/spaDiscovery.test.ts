// Second-level discovery over career pages that render their jobs in the
// browser, plus the employer-page link reader they share a tier with.

import { describe, expect, it } from "vitest";
import {
  detectEmbeddedAtsBoard,
  discoverFromRenderedShell,
  extractApiHints,
  parseEmbeddedStateJobs,
  parseJsonLdJobPostings,
} from "@/lib/ats/spaDiscovery";
import {
  extractOfficialJobLinks,
  titleFromJobUrl,
} from "@/lib/ats/employerPageLinks";
import { detectClientRenderedAts } from "@/lib/ats/detect";

const PAGE = "https://acme.com/careers";

describe("schema.org JobPosting extraction", () => {
  it("reads a JobPosting block including its canonical URL and real description", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "Mechanical Engineering Intern",
      description: "<p>You will design <b>fixtures</b>.</p>",
      datePosted: "2026-08-20",
      identifier: { "@type": "PropertyValue", value: "REQ-77" },
      hiringOrganization: { "@type": "Organization", name: "Acme" },
      jobLocation: {
        "@type": "Place",
        address: { addressLocality: "Austin", addressRegion: "TX", addressCountry: "US" },
      },
      url: "https://acme.com/careers/jobs/mechanical-engineering-intern",
    })}</script>`;

    const jobs = parseJsonLdJobPostings(html, PAGE, "Acme");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: "Mechanical Engineering Intern",
      requisitionId: "REQ-77",
      company: "Acme",
      location: "Austin, TX, US",
      applyUrl: "https://acme.com/careers/jobs/mechanical-engineering-intern",
      description: "You will design fixtures.",
    });
    expect(jobs[0]!.postedAt?.toISOString().slice(0, 10)).toBe("2026-08-20");
  });

  it("finds JobPostings nested inside an @graph or ItemList", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@graph": [
        { "@type": "WebSite", name: "Acme" },
        { "@type": "JobPosting", title: "Software Intern", url: "https://acme.com/jobs/1" },
      ],
    })}</script>`;
    expect(parseJsonLdJobPostings(html, PAGE, "Acme")).toHaveLength(1);
  });

  it("survives one malformed block without discarding the rest of the page", () => {
    const html =
      `<script type="application/ld+json">{ not json </script>` +
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "JobPosting",
        title: "Data Intern",
        url: "https://acme.com/jobs/2",
      })}</script>`;
    expect(parseJsonLdJobPostings(html, PAGE, "Acme")).toHaveLength(1);
  });

  it("marks a remote posting as Remote", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title: "Remote Intern",
      jobLocationType: "TELECOMMUTE",
      url: "https://acme.com/jobs/3",
    })}</script>`;
    expect(parseJsonLdJobPostings(html, PAGE, "Acme")[0]).toMatchObject({
      location: "Remote",
      workplaceType: "Remote",
    });
  });
});

describe("embedded framework state", () => {
  it("recovers internships from a __NEXT_DATA__ blob", () => {
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          openings: [
            { id: "9", title: "Firmware Engineering Intern", url: "/careers/jobs/9", location: "Boise, ID" },
            { id: "10", title: "VP of Sales", url: "/careers/jobs/10" },
          ],
        },
      },
    })}</script>`;
    const jobs = parseEmbeddedStateJobs(html, PAGE, "Acme");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: "Firmware Engineering Intern",
      applyUrl: "https://acme.com/careers/jobs/9",
      location: "Boise, ID",
    });
  });

  it("ignores a state blob with nothing job-shaped in it", () => {
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { hero: { title: "Join us" } } },
    })}</script>`;
    expect(parseEmbeddedStateJobs(html, PAGE, "Acme")).toEqual([]);
  });
});

describe("embedded boards and API hints", () => {
  it("treats an iframed ATS board as the page's real job content", () => {
    const html = `<iframe src="https://boards.greenhouse.io/acme?for=acme"></iframe>`;
    expect(detectEmbeddedAtsBoard(html)).toEqual({
      atsType: "greenhouse",
      atsIdentifier: "acme",
    });
  });

  it("does not treat an unrelated script tag as a board", () => {
    expect(detectEmbeddedAtsBoard(`<script src="https://cdn.acme.com/app.js"></script>`)).toBeNull();
  });

  it("collects JSON endpoints the page names, for a follow-up fetch", () => {
    const html = `<script>fetch("/api/jobs/search?q=");const w="/widgets/positions";</script>`;
    const hints = extractApiHints(html, PAGE);
    expect(hints).toContain("https://acme.com/api/jobs/search");
  });
});

describe("client-rendered vendor fingerprints", () => {
  it("identifies an Eightfold site and keeps the employer host in the identifier", () => {
    const html = `<script src="https://static.vscdn.net/x.js"></script><script>window._EF_GROUP_ID = "globalfoundries.com";</script>`;
    expect(detectClientRenderedAts(html, "https://careers.gf.com/careers")).toEqual({
      atsType: "eightfold",
      atsIdentifier: "careers.gf.com|globalfoundries.com",
    });
  });

  it("identifies a Phenom site from its refNum", () => {
    const html = `<link href="https://cdn.phenompeople.com/CareerConnectResources/PGBPGNGLOBAL/canvas/x.css">`;
    expect(detectClientRenderedAts(html, "https://www.pgcareers.com/careers")).toEqual({
      atsType: "phenom",
      atsIdentifier: "www.pgcareers.com|PGBPGNGLOBAL",
    });
  });

  it("stays unknown when neither vendor marker is present", () => {
    expect(detectClientRenderedAts("<html><body>Careers</body></html>", PAGE)).toEqual({
      atsType: "unknown",
      atsIdentifier: null,
    });
  });
});

describe("official job links on an employer's own page", () => {
  it("REGRESSION: reads a walled iCIMS board through the employer's own page", () => {
    // Every URL shape on careers-walterpmoore.icims.com answers HTTP 405
    // "Human Verification", even from a real browser. The employer's own page
    // links straight to the same postings in plain HTML.
    const html = `
      <a href="https://careers-walterpmoore.icims.com/jobs/4201/cad-tech-intern---public-works/job?mode=apply&amp;apply=yes">CAD Tech Intern - Public Works</a>
      <a href="https://careers-walterpmoore.icims.com/jobs/4206/design-engineer-i---structural/job">Design Engineer I - Structural</a>
      <a href="https://www.walterpmoore.com/about">About us</a>
    `;
    const jobs = extractOfficialJobLinks(html, "https://www.walterpmoore.com/careers", "Walter P Moore");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: "CAD Tech Intern - Public Works",
      requisitionId: "4201",
    });
    expect(jobs[0]!.applyUrl).toContain("careers-walterpmoore.icims.com/jobs/4201/");
  });

  it("never returns a careers landing page or a search URL as a destination", () => {
    const html = `
      <a href="https://acme.com/careers">Careers — see all intern openings</a>
      <a href="https://acme.com/jobs/search?q=intern">Search intern jobs</a>
    `;
    expect(extractOfficialJobLinks(html, PAGE, "Acme")).toEqual([]);
  });

  it("never returns an aggregator link", () => {
    const html = `<a href="https://jobright.ai/jobs/info/abc">Software Intern</a>`;
    expect(extractOfficialJobLinks(html, PAGE, "Acme")).toEqual([]);
  });

  it("falls back to the URL slug when the anchor text is unusable", () => {
    const html = `<a href="https://careers-acme.icims.com/jobs/4201/cad-tech-intern---public-works/job"><img src="x.png"></a>`;
    expect(extractOfficialJobLinks(html, PAGE, "Acme")[0]?.title).toBe(
      "Cad Tech Intern Public Works",
    );
  });

  it("derives a readable title from a job URL slug", () => {
    expect(titleFromJobUrl("https://x.icims.com/jobs/4201/cad-tech-intern---public-works/job")).toBe(
      "Cad Tech Intern Public Works",
    );
    expect(titleFromJobUrl("https://x.com/jobs/1234")).toBeNull();
  });
});

describe("discoverFromRenderedShell", () => {
  it("reports every no-browser signal it found on one page", () => {
    const html =
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "JobPosting",
        title: "Systems Intern",
        url: "https://acme.com/careers/jobs/5",
      })}</script>` +
      `<iframe src="https://jobs.lever.co/acme"></iframe>` +
      `<a href="https://acme.com/careers/jobs/5">Systems Intern</a>`;

    const shell = discoverFromRenderedShell(html, PAGE, "Acme");
    expect(shell.jobs).toHaveLength(1);
    expect(shell.embeddedAts).toEqual({ atsType: "lever", atsIdentifier: "acme" });
    expect(shell.officialJobLinks).toBe(1);
  });

  it("reports nothing for a genuinely empty shell", () => {
    const shell = discoverFromRenderedShell("<html><div id=root></div></html>", PAGE, "Acme");
    expect(shell.jobs).toEqual([]);
    expect(shell.embeddedAts).toBeNull();
    expect(shell.officialJobLinks).toBe(0);
  });
});
