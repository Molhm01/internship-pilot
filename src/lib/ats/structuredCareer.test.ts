import { describe, expect, it } from "vitest";
import { parseStructuredJobPage, stripPortalHtml } from "@/lib/ats/structuredCareer";

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

  it("strips scripts, styles, tags, and common HTML entities", () => {
    expect(stripPortalHtml("<style>x</style><script>y</script><p>PCB &amp; FPGA&nbsp; work</p>")).toContain("PCB & FPGA");
  });
});
