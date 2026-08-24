import { describe, expect, it } from "vitest";

import { ibmJobIdFrom, parseIbmCareersJobs } from "@/lib/ats/ibmCareers";
import { detectAtsFromText } from "@/lib/ats/detect";

/**
 * IBM's public careers search, whose contract was observed from IBM's own page
 * rather than guessed. The payload below is the real response shape.
 */
const PAYLOAD = {
  hits: {
    total: { value: 179 },
    hits: [
      {
        _id: "0f4831b26e3dd9ab",
        _source: {
          language: "en",
          url: "https://careers.ibm.com/careers/JobDetail?jobId=128645",
          title: "Data Engineer Intern 2027",
          description: "<p>Join IBM as a <b>Data Engineer Intern</b>.</p>",
          field_keyword_17: "Hybrid",
          field_keyword_18: "Internship",
          field_keyword_19: "Multiple Cities",
        },
      },
      {
        _id: "abc",
        _source: {
          url: "https://careers.ibm.com/careers/JobDetail?jobId=128792",
          title: "Intern Data Specialist 2027 - AI & Analytics",
          description: "Analytics internship.",
          field_keyword_18: "Internship",
          field_keyword_19: "Lansing, US",
        },
      },
      // Must be dropped: not an IBM-owned destination.
      { _source: { url: "https://www.linkedin.com/jobs/view/123", title: "Intern" } },
      // Must be dropped: no title.
      { _source: { url: "https://careers.ibm.com/careers/JobDetail?jobId=1" } },
    ],
  },
};

describe("IBM public careers search", () => {
  it("keeps IBM's own JobDetail page as the canonical apply URL", () => {
    const jobs = parseIbmCareersJobs(PAYLOAD, "IBM");
    expect(jobs[0]!.applyUrl).toBe("https://careers.ibm.com/careers/JobDetail?jobId=128645");
    expect(jobs[0]!.requisitionId).toBe("128645");
    expect(jobs[0]!.sourceJobId).toBe("128645");
  });

  it("refuses any destination that is not on an IBM domain", () => {
    const jobs = parseIbmCareersJobs(PAYLOAD, "IBM");
    expect(jobs.every((job) => /ibm\.com/.test(job.applyUrl))).toBe(true);
    expect(jobs).toHaveLength(2);
  });

  it("reads location and workplace type from the facets IBM's own page uses", () => {
    const [first, second] = parseIbmCareersJobs(PAYLOAD, "IBM");
    expect(first!.location).toBe("Multiple Cities");
    expect(first!.workplaceType).toBe("Hybrid");
    expect(second!.location).toBe("Lansing, US");
    expect(second!.workplaceType).toBeNull();
  });

  it("keeps IBM's own description as text and never synthesizes one", () => {
    const [first] = parseIbmCareersJobs(PAYLOAD, "IBM");
    expect(first!.description).toBe("Join IBM as a Data Engineer Intern.");
  });

  it("records NO posting date rather than inventing one", () => {
    // The endpoint exposes no publication date. Discovery time is not posting
    // time, so the field stays null and the row is recorded as UNKNOWN.
    for (const job of parseIbmCareersJobs(PAYLOAD, "IBM")) {
      expect(job.postedAt).toBeNull();
      expect(job.postedAtText).toBeNull();
    }
  });

  it("extracts the requisition id IBM itself uses", () => {
    expect(ibmJobIdFrom("https://careers.ibm.com/careers/JobDetail?jobId=129622")).toBe("129622");
    expect(ibmJobIdFrom("https://careers.ibm.com/careers/JobDetail")).toBeNull();
    expect(ibmJobIdFrom("not a url")).toBeNull();
  });

  it("returns nothing for an empty or malformed payload", () => {
    expect(parseIbmCareersJobs(null, "IBM")).toEqual([]);
    expect(parseIbmCareersJobs({}, "IBM")).toEqual([]);
    expect(parseIbmCareersJobs({ hits: { hits: [] } }, "IBM")).toEqual([]);
  });
});

describe("IBM careers detection", () => {
  it("routes an IBM careers host to the observed search adapter", () => {
    expect(detectAtsFromText('<a href="https://careers.ibm.com/">Careers</a>')).toEqual({
      atsType: "ibm-careers",
      atsIdentifier: "ibm",
    });
    expect(detectAtsFromText("https://www.ibm.com/careers/search").atsType).toBe("ibm-careers");
  });
});
