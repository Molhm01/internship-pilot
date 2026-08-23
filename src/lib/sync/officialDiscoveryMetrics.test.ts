import { describe, expect, it } from "vitest";
import {
  classifyFreshRecall,
  gapGroup,
  isUsableProviderConfig,
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
    expect(isUsableProviderConfig({ atsType: "workday", atsIdentifier: "acme/External", careersUrl: null })).toBe(true);
    expect(isUsableProviderConfig({ atsType: "workday", atsIdentifier: null, careersUrl: "https://acme.test/jobs" })).toBe(false);
    expect(isUsableProviderConfig({ atsType: "successfactors", atsIdentifier: null, careersUrl: "https://jobs.acme.test" })).toBe(true);
    expect(isUsableProviderConfig({ atsType: "greenhouse", atsIdentifier: "embed", careersUrl: "https://acme.test/jobs" })).toBe(false);
    expect(isUsableProviderConfig({ atsType: "workday", atsIdentifier: "acme.wd5/en-US", careersUrl: "https://acme.test/jobs" })).toBe(false);
    expect(isUsableProviderConfig({ atsType: "custom", atsIdentifier: null, careersUrl: "https://acme.test/jobs" })).toBe(false);
  });

  it("classifies true fresh recall instead of URL-resolution percentage", () => {
    expect(classifyFreshRecall({ state: "RESOLVED", resolutionPath: "already_official", reasonCode: null })).toBe("ALREADY_FOUND_OFFICIALLY");
    expect(classifyFreshRecall({ state: "RESOLVED", resolutionPath: "employer_board", reasonCode: null })).toBe("RESOLVED_AFTER_PRIORITY_TRIGGER");
    expect(classifyFreshRecall({ state: "PENDING", resolutionPath: null, reasonCode: "TITLE_MATCH_TOO_LOW" })).toBe("OFFICIAL_JOB_EXISTS_BUT_MATCH_FAILED");
  });

  it("reports measured gap groups and p90", () => {
    expect(gapGroup("BOT_WALL_BLOCKED")).toBe("provider bot wall");
    expect(gapGroup("NO_ATS_CONFIG")).toBe("provider missing");
    expect(percentile([10, 20, 30, 40, 50], 0.9)).toBe(50);
  });
});
