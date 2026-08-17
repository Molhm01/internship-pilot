import { describe, expect, it } from "vitest";
import { inferResolvedSource } from "@/lib/sync/discoveryResolution";

describe("resolved discovery source inference", () => {
  it("recognizes Greenhouse", () => {
    expect(inferResolvedSource("https://boards.greenhouse.io/acme/jobs/123")).toEqual({
      source: "greenhouse",
      atsType: "greenhouse",
      atsTenant: "acme",
    });
  });

  it("recognizes Lever", () => {
    expect(inferResolvedSource("https://jobs.lever.co/acme/abc-123")).toEqual({
      source: "lever",
      atsType: "lever",
      atsTenant: "acme",
    });
  });

  it("preserves Workday tenant and site", () => {
    expect(
      inferResolvedSource("https://acme.wd5.myworkdayjobs.com/External/job/Boston/Intern_R123"),
    ).toEqual({
      source: "workday",
      atsType: "workday",
      atsTenant: "acme.wd5/External",
    });
  });

  it("recognizes iCIMS", () => {
    expect(inferResolvedSource("https://careers-acme.icims.com/jobs/123/intern/job")).toEqual({
      source: "icims",
      atsType: "icims",
      atsTenant: "careers-acme.icims.com",
    });
  });

  it("keeps employer-hosted job pages as direct custom sources", () => {
    expect(inferResolvedSource("https://careers.acme.com/jobs/electrical-engineering-intern")).toEqual({
      source: "other",
      atsType: "custom",
      atsTenant: "careers.acme.com",
    });
  });
});
