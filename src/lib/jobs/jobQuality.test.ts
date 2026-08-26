import { describe, expect, it } from "vitest";
import { dateQuality, destinationQuality, jobDescriptionQuality } from "./jobQuality";

describe("canonical job quality diagnostics", () => {
  it("keeps exact, date-only, and unknown date evidence distinct", () => {
    expect(dateQuality({ sourcePostedAt: new Date(), sourceDateConfidence: "EXACT" })).toBe("EXACT_TIMESTAMP");
    expect(dateQuality({ sourcePostedAt: new Date(), sourceDateConfidence: "DATE_ONLY" })).toBe("DATE_ONLY");
    expect(dateQuality({ sourcePostedAt: null })).toBe("UNKNOWN");
  });

  it("classifies description completeness reproducibly", () => {
    expect(jobDescriptionQuality({ description: "" })).toBe("MISSING");
    expect(jobDescriptionQuality({ description: "brief" })).toBe("THIN");
    expect(jobDescriptionQuality({ description: "Responsibilities and qualifications. ".repeat(20) })).toBe("FULL");
  });

  it("distinguishes canonical apply destinations from board-only links", () => {
    expect(destinationQuality({ officialApplicationUrl: "https://jobs.example/1", resolutionStatus: "RESOLVED" }))
      .toBe("CANONICAL_OFFICIAL");
    expect(destinationQuality({ sourceListingUrl: "https://jobs.example" })).toBe("OFFICIAL_BOARD");
    expect(destinationQuality({})).toBe("UNRESOLVED");
  });
});
