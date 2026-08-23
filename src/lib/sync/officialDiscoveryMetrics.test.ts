import { describe, expect, it } from "vitest";
import {
  classifyFreshRecall,
  gapGroup,
  isUsableProviderConfig,
  normalizedConfigState,
  postingQualityTelemetry,
  percentile,
  reportProvider,
} from "@/lib/sync/officialDiscoveryMetrics";

describe("official discovery reporting", () => {
  it("normalizes every requested provider bucket", () => {
    expect(reportProvider("smartrecruiters")).toBe("SmartRecruiters");
    expect(reportProvider("spa")).toBe("Custom/API");
    expect(reportProvider(null)).toBe("Unknown");
  });

  it("distinguishes provider knowledge from a usable configuration", () => {
    expect(isUsableProviderConfig({ atsType: "workday", atsIdentifier: "acme/External", careersUrl: null, atsConfigState: "UNTESTED" })).toBe(false);
    expect(isUsableProviderConfig({ atsType: "workday", atsIdentifier: "acme/External", careersUrl: null, atsConfigState: "VALIDATED" })).toBe(true);
    expect(isUsableProviderConfig({ atsType: "workday", atsIdentifier: null, careersUrl: "https://acme.test/jobs" })).toBe(false);
    expect(isUsableProviderConfig({ atsType: "successfactors", atsIdentifier: null, careersUrl: "https://jobs.acme.test", atsConfigState: "VALIDATED" })).toBe(true);
    expect(isUsableProviderConfig({ atsType: "greenhouse", atsIdentifier: "embed", careersUrl: "https://acme.test/jobs" })).toBe(false);
    expect(isUsableProviderConfig({ atsType: "workday", atsIdentifier: "acme.wd5/en-US", careersUrl: "https://acme.test/jobs" })).toBe(false);
    expect(isUsableProviderConfig({ atsType: "custom", atsIdentifier: null, careersUrl: "https://acme.test/jobs" })).toBe(false);
    expect(normalizedConfigState({ atsType: "greenhouse", atsIdentifier: "embed", careersUrl: null, atsConfigState: "VALIDATED" })).toBe("MALFORMED");
  });

  it("counts authoritative timestamp precision and JD hydration without guessing", () => {
    const capturedAt = new Date("2026-08-23T12:00:00.000Z");
    const quality = postingQualityTelemetry([
      { sourceJobId: "1", title: "Intern", company: "A", location: null, workplaceType: null, applyUrl: "https://a.test/1", description: "x".repeat(201), postedAt: new Date("2026-08-23T11:15:00.000Z") },
      { sourceJobId: "2", title: "Intern", company: "A", location: null, workplaceType: null, applyUrl: "https://a.test/2", description: "", postedAt: new Date("2026-08-22T00:00:00.000Z") },
      { sourceJobId: "3", title: "Intern", company: "A", location: null, workplaceType: null, applyUrl: "https://a.test/3", description: "", postedAt: null, postedAtText: "Posted 2 Hours Ago" },
      { sourceJobId: "4", title: "Intern", company: "A", location: null, workplaceType: null, applyUrl: "https://a.test/4", description: "", postedAt: null },
    ], capturedAt);
    expect(quality).toEqual({
      fullJdJobs: 1,
      exactTimestampJobs: 1,
      dateOnlyJobs: 1,
      relativeParsedJobs: 1,
      radarFallbackJobs: 0,
      unknownTimestampJobs: 1,
    });
  });

  it("classifies true fresh recall instead of URL-resolution percentage", () => {
    expect(classifyFreshRecall({ state: "RESOLVED", resolutionPath: "already_official", reasonCode: null })).toBe("ALREADY_FOUND_OFFICIALLY");
    expect(classifyFreshRecall({ state: "RESOLVED", resolutionPath: "employer_board", reasonCode: null })).toBe("RESOLVED_AFTER_PRIORITY_TRIGGER");
    expect(classifyFreshRecall({ state: "PENDING", resolutionPath: null, reasonCode: "TITLE_MATCH_TOO_LOW" })).toBe("OFFICIAL_JOB_EXISTS_BUT_MATCH_FAILED");
    expect(classifyFreshRecall({ state: "PENDING", resolutionPath: null, reasonCode: "BOARD_ROLE_NOT_INDEXED" })).toBe("OFFICIAL_JOB_EXISTS_BUT_MATCH_FAILED");
  });

  it("reports measured gap groups and p90", () => {
    expect(gapGroup("BOT_WALL_BLOCKED")).toBe("provider bot wall");
    expect(gapGroup("NO_ATS_CONFIG")).toBe("provider missing");
    expect(gapGroup("BOARD_WRONG_EMPLOYER")).toBe("wrong employer board");
    expect(gapGroup("BOARD_ROLE_NOT_INDEXED")).toBe("official posting indexing delay");
    expect(percentile([10, 20, 30, 40, 50], 0.9)).toBe(50);
  });
});
