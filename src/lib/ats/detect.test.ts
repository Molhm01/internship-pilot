import { describe, expect, it } from "vitest";
import { detectAtsFromText } from "@/lib/ats/detect";

describe("detectAtsFromText", () => {
  it("detects the structured ATS vendors used by direct ingestion", () => {
    expect(detectAtsFromText("https://job-boards.greenhouse.io/acme/jobs/123")).toEqual({
      atsType: "greenhouse",
      atsIdentifier: "acme",
    });
    expect(detectAtsFromText("https://jobs.lever.co/acme/123")).toEqual({
      atsType: "lever",
      atsIdentifier: "acme",
    });
    expect(detectAtsFromText("https://jobs.ashbyhq.com/acme/123")).toEqual({
      atsType: "ashby",
      atsIdentifier: "acme",
    });
    expect(detectAtsFromText("https://jobs.smartrecruiters.com/Acme/123-example")).toEqual({
      atsType: "smartrecruiters",
      atsIdentifier: "Acme",
    });
    expect(detectAtsFromText("https://careers-acme.icims.com/jobs/search?ss=1")).toEqual({
      atsType: "icims",
      atsIdentifier: "careers-acme",
    });
  });

  it("detects SuccessFactors public career hosts on .com and .eu", () => {
    expect(detectAtsFromText("https://tenant.successfactors.com/career")).toEqual({
      atsType: "successfactors",
      atsIdentifier: "tenant",
    });
    expect(detectAtsFromText("https://career5.successfactors.eu/career?company=acme")).toEqual({
      atsType: "successfactors",
      atsIdentifier: "career5",
    });
  });

  it("extracts the tenant from Greenhouse embed URLs instead of persisting embed", () => {
    expect(detectAtsFromText(
      '<script src="https://boards.greenhouse.io/embed/job_board/js?for=astspacemobile"></script>',
    )).toEqual({ atsType: "greenhouse", atsIdentifier: "astspacemobile" });
    expect(detectAtsFromText("https://boards.greenhouse.io/embed/job_board/js")).toEqual({
      atsType: "unknown",
      atsIdentifier: null,
    });
  });

  it("preserves the Workday shard and site in the identifier", () => {
    expect(
      detectAtsFromText("https://micron.wd1.myworkdayjobs.com/External/job/Boise/Intern_R123"),
    ).toEqual({
      atsType: "workday",
      atsIdentifier: "micron.wd1/External",
    });

    expect(
      detectAtsFromText("https://example.wd12.myworkdayjobs.com/University/job/Test/Intern_R456"),
    ).toEqual({
      atsType: "workday",
      atsIdentifier: "example.wd12/University",
    });
  });

  it("returns unknown when no supported ATS signature is present", () => {
    expect(detectAtsFromText("https://example.com/careers")).toEqual({
      atsType: "unknown",
      atsIdentifier: null,
    });
  });
});
