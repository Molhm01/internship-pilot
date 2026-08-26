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

describe("SuccessFactors detail-link discovery does not lose real internships", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function jobPage(title: string) {
    return `<html><head><title>${title}</title></head><body>
      <h1>${title}</h1>
      <div itemprop="description">${"Responsibilities and qualifications. ".repeat(20)}</div>
    </body></html>`;
  }

  it("REGRESSION: does not require the list-page anchor text to say 'intern' to fetch a detail page", async () => {
    // Gulfstream Aerospace measured: 131 real detail links on its
    // SuccessFactors board, 0 of whose list-page anchor text contained
    // "intern"/"co-op" — the true title only appears on the detail page. The
    // old pre-filter dropped every one of them before a single detail page
    // was ever fetched. The real STUDENT_ROLE_HINT check on the PARSED title
    // (not the anchor text) is what should decide inclusion.
    const landing = `<html><body>
      <a href="/job/Senior-Engineer-GA/1000/">Senior Engineer</a>
      <a href="/job/Engineering-Intern-GA/1001/">Engineering Intern</a>
    </body></html>`;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "https://careers.acme.example/") {
        return Promise.resolve(new Response(landing, { status: 200, headers: { "content-type": "text/html" } }));
      }
      if (url.includes("/job/Senior-Engineer-GA/1000/")) {
        return Promise.resolve(new Response(jobPage("Senior Engineer"), { status: 200, headers: { "content-type": "text/html" } }));
      }
      if (url.includes("/job/Engineering-Intern-GA/1001/")) {
        return Promise.resolve(new Response(jobPage("Engineering Intern"), { status: 200, headers: { "content-type": "text/html" } }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    }) as unknown as typeof fetch;

    const probe = await probeStructuredPortalJobs({
      kind: "successfactors",
      companyName: "Acme",
      careersUrl: "https://careers.acme.example/",
      maxListPages: 1,
      maxJobDetails: 10,
    });
    expect(probe.jobs.map((j) => j.title)).toContain("Engineering Intern");
    // A non-intern role is still correctly excluded, by its real title.
    expect(probe.jobs.map((j) => j.title)).not.toContain("Senior Engineer");
  });

  it("REGRESSION: visits a student-labeled category page before a generic one, within a bounded detail budget", async () => {
    // A board with many "Engineering" category jobs discovered before an
    // "Entry-level Positions and Internships" category must not let the
    // generic category crowd every internship out of a bounded detail-fetch
    // budget (maxJobDetails).
    const landing = `<html><body>
      <a href="/go/Engineering/1">Engineering</a>
      <a href="/go/Entry-level-Positions-and-Internships/2">Entry-level Positions and Internships</a>
    </body></html>`;
    const engineeringCategory = Array.from({ length: 5 }, (_, i) =>
      `<a href="/job/Senior-Engineer-${i}/${2000 + i}/">Senior Engineer ${i}</a>`).join("\n");
    const internCategory = `<a href="/job/Intern-Role/3000/">Intern Role</a>`;

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "https://careers.acme.example/") {
        return Promise.resolve(new Response(landing, { status: 200, headers: { "content-type": "text/html" } }));
      }
      if (url.includes("/go/Engineering/1")) {
        return Promise.resolve(new Response(`<html><body>${engineeringCategory}</body></html>`, { status: 200, headers: { "content-type": "text/html" } }));
      }
      if (url.includes("/go/Entry-level-Positions-and-Internships/2")) {
        return Promise.resolve(new Response(`<html><body>${internCategory}</body></html>`, { status: 200, headers: { "content-type": "text/html" } }));
      }
      if (url.includes("/job/Intern-Role/3000/")) {
        return Promise.resolve(new Response(jobPage("Software Engineering Intern"), { status: 200, headers: { "content-type": "text/html" } }));
      }
      if (/\/job\/Senior-Engineer-/.test(url)) {
        return Promise.resolve(new Response(jobPage("Senior Engineer"), { status: 200, headers: { "content-type": "text/html" } }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    }) as unknown as typeof fetch;

    const probe = await probeStructuredPortalJobs({
      kind: "successfactors",
      companyName: "Acme",
      careersUrl: "https://careers.acme.example/",
      maxListPages: 3,
      maxJobDetails: 3, // smaller than the 5 Engineering + 1 Intern candidates
    });
    expect(probe.jobs.map((j) => j.title)).toContain("Software Engineering Intern");
  });
});
