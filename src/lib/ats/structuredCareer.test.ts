import { afterEach, describe, expect, it, vi } from "vitest";
import { parseStructuredJobPage, stripPortalHtml,
  normalizePostingTitle,
  probeStructuredPortalJobs,
} from "@/lib/ats/structuredCareer";

describe("structured public ATS job parsing", () => {
  it("normalizes JobPosting JSON-LD into an AtsJob", () => {
    const html = `
      <html><head>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "Electrical Engineering Intern",
            "description": "<p>Design PCBs and validate embedded hardware.</p>",
            "datePosted": "2026-08-16",
            "identifier": { "@type": "PropertyValue", "value": "REQ-123" },
            "employmentType": "INTERN",
            "jobLocationType": "TELECOMMUTE",
            "jobLocation": {
              "@type": "Place",
              "address": {
                "@type": "PostalAddress",
                "addressLocality": "Clifton",
                "addressRegion": "NJ",
                "addressCountry": "US"
              }
            },
            "url": "https://careers-acme.icims.com/jobs/123/electrical-engineering-intern/job"
          }
        </script>
      </head></html>`;

    const job = parseStructuredJobPage(
      html,
      "https://careers-acme.icims.com/jobs/123/electrical-engineering-intern/job",
      "Acme Robotics",
    );

    expect(job).not.toBeNull();
    expect(job?.sourceJobId).toBe("REQ-123");
    expect(job?.requisitionId).toBe("REQ-123");
    expect(job?.title).toBe("Electrical Engineering Intern");
    expect(job?.company).toBe("Acme Robotics");
    expect(job?.location).toBe("Clifton, NJ, US");
    expect(job?.workplaceType).toBe("Remote");
    expect(job?.description).toContain("Design PCBs");
    expect(job?.applyUrl).toBe("https://careers-acme.icims.com/jobs/123/electrical-engineering-intern/job");
    expect(job?.postedAt?.toISOString().startsWith("2026-08-16")).toBe(true);
  });

  it("falls back to an official page heading when JSON-LD is absent", () => {
    const html = `
      <html>
        <head><meta name="description" content="Hands-on hardware validation role"></head>
        <body><h1>Hardware Engineering Co-op</h1></body>
      </html>`;

    const job = parseStructuredJobPage(
      html,
      "https://career5.successfactors.eu/career?company=acme&career_ns=job_listing&career_job_req_id=456",
      "Acme Hardware",
    );

    expect(job?.sourceJobId).toBe("456");
    expect(job?.title).toBe("Hardware Engineering Co-op");
    expect(job?.description).toBe("Hands-on hardware validation role");
  });

  it("hydrates SuccessFactors microdata when JSON-LD is absent", () => {
    const html = `
      <meta itemprop="addressLocality" content="Galway">
      <meta itemprop="addressRegion" content="G">
      <meta itemprop="addressCountry" content="IE">
      <meta itemprop="datePosted" content="Thu Jul 30 00:00:00 UTC 2026">
      <h1 itemprop="title">Operations Engineering Support Student Intern</h1>
      <span itemprop="description" class="jobdescription">
        <p>Req ID: 138637</p><div>${"Build and validate embedded manufacturing systems. ".repeat(8)}</div>
      </span>
      <form class="form-inline frmSocialSubscribe"></form>`;
    const job = parseStructuredJobPage(
      html,
      "https://careers.celestica.com/job/Galway/1420816533/",
      "Celestica",
    );
    expect(job?.location).toBe("Galway, G, IE");
    expect(job?.postedAt?.toISOString()).toBe("2026-07-30T00:00:00.000Z");
    expect(job?.description.length).toBeGreaterThan(200);
    expect(job?.description).toContain("Build and validate embedded manufacturing systems");
  });

  it("strips scripts, styles, tags, and common HTML entities", () => {
    expect(stripPortalHtml("<style>x</style><script>y</script><p>PCB &amp; FPGA work</p>")).toBe("PCB & FPGA work");
  });
});

describe("portal field labels rendered into the title", () => {
  it("REGRESSION: strips the 'Title:' label SuccessFactors tenants emit", () => {
    // Measured on CMC, where all three postings came back as "Title: …". The
    // extra token dragged an exact counterpart under the accept bar.
    expect(normalizePostingTitle("Title: AI Intern- Recycling")).toBe("AI Intern- Recycling");
    expect(normalizePostingTitle("Job Title: Data Engineering Intern")).toBe("Data Engineering Intern");
    expect(normalizePostingTitle("Position: Electrical Engineering Co-Op")).toBe("Electrical Engineering Co-Op");
  });

  it("leaves a job genuinely named after a title alone", () => {
    expect(normalizePostingTitle("Title Insurance Intern")).toBe("Title Insurance Intern");
    expect(normalizePostingTitle("Software Engineer Intern")).toBe("Software Engineer Intern");
  });

  it("removes only ONE leading label", () => {
    expect(normalizePostingTitle("Title: Title Examiner Intern")).toBe("Title Examiner Intern");
  });
});

describe("iCIMS bot-wall detection via HTTP 405", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockFetch(status: number) {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("Human Verification Required", { status, headers: { "content-type": "text/html" } }),
    ) as unknown as typeof fetch;
  }

  it("REGRESSION: recognizes iCIMS's documented HTTP 405 bot-wall response", async () => {
    // Kimley-Horn's iCIMS board answered every automated GET with 405 and was
    // being silently recorded as a reachable board with zero jobs (a real
    // production miss, not a bot wall) — undercounting bot-wall exclusions
    // and inflating the supported/reachable miss count with an unfixable case.
    mockFetch(405);
    const probe = await probeStructuredPortalJobs({
      kind: "icims",
      companyName: "Kimley-Horn",
      careersUrl: "https://jobs-kimley-horn.icims.com/jobs/search",
      maxListPages: 1,
    });
    expect(probe.botWallBlocked).toBe(true);
  });

  it("does not treat a plain 405 from a non-iCIMS provider as a bot wall", async () => {
    // 405 is iCIMS's specific documented signature — not a generic rule.
    mockFetch(405);
    const probe = await probeStructuredPortalJobs({
      kind: "successfactors",
      companyName: "Acme",
      careersUrl: "https://careers.acme.example/",
      maxListPages: 1,
    });
    expect(probe.botWallBlocked).toBe(false);
  });

  it("REGRESSION: reports ATS_BOT_WALL even when an unrelated marketing page loaded fine", async () => {
    // Kimley-Horn's public careers page (the crawl's first URL) returns 200;
    // only the iCIMS "/jobs/search" list endpoints it links to return 405. One
    // successful, job-less page was previously enough to hide the bot wall
    // behind a silent "supported, zero postings" result instead of surfacing
    // ATS_BOT_WALL.
    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? new Response("<html><body>Careers at Kimley-Horn</body></html>", { status: 200, headers: { "content-type": "text/html" } })
          : new Response("Human Verification Required", { status: 405, headers: { "content-type": "text/html" } }),
      );
    }) as unknown as typeof fetch;

    await expect(probeStructuredPortalJobs({
      kind: "icims",
      companyName: "Kimley-Horn",
      careersUrl: "https://www.kimley-horn.com/careers/",
      additionalStartUrls: ["https://jobs-kimley-horn.icims.com/jobs/search?ss=1"],
      maxListPages: 6,
      throwOnFetchError: true,
    })).rejects.toMatchObject({ code: "ATS_BOT_WALL" });
  });

  it("still recognizes the pre-existing 401/403/429 bot-wall statuses for iCIMS", async () => {
    for (const status of [401, 403, 429]) {
      mockFetch(status);
      const probe = await probeStructuredPortalJobs({
        kind: "icims",
        companyName: "Kimley-Horn",
        careersUrl: "https://jobs-kimley-horn.icims.com/jobs/search",
        maxListPages: 1,
      });
      expect(probe.botWallBlocked).toBe(true);
    }
  });
});
