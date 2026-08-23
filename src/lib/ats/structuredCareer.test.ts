import { describe, expect, it } from "vitest";
import { parseStructuredJobPage, stripPortalHtml,
  normalizePostingTitle,
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
