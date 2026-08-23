import { describe, expect, it } from "vitest";
import { computeBoardDelta } from "@/lib/sync/officialBoardDelta";
import { pollingTierFor } from "@/lib/sync/companyDiscovery";

const tracked = (misses = 0) => ({ id: "job-1", sourceJobId: "req-1", consecutiveBoardMisses: misses });

describe("official board delta discovery", () => {
  it("detects a newly published requisition", () => {
    const delta = computeBoardDelta({
      previousSourceJobIds: ["req-1"],
      currentSourceJobIds: ["req-1", "req-2"],
      trackedJobs: [tracked()],
      successful: true,
    });
    expect(delta.newSourceJobIds).toEqual(["req-2"]);
    expect(delta.missingJobIds).toEqual([]);
  });

  it("requires two successful missing snapshots before closure", () => {
    const first = computeBoardDelta({
      previousSourceJobIds: ["req-1"], currentSourceJobIds: ["req-2"], trackedJobs: [tracked(0)], successful: true,
    });
    const second = computeBoardDelta({
      previousSourceJobIds: ["req-2"], currentSourceJobIds: ["req-2"], trackedJobs: [tracked(1)], successful: true,
    });
    expect(first.missingJobIds).toEqual(["job-1"]);
    expect(first.closeJobIds).toEqual([]);
    expect(second.closeJobIds).toEqual(["job-1"]);
  });

  it("never closes or increments absence on a transient fetch failure", () => {
    const delta = computeBoardDelta({
      previousSourceJobIds: ["req-1"], currentSourceJobIds: [], trackedJobs: [tracked(12)], successful: false,
    });
    expect(delta).toEqual({ newSourceJobIds: [], presentJobIds: [], missingJobIds: [], closeJobIds: [] });
  });
});

describe("provider-aware polling tiers", () => {
  it("uses Tier A for high-value employers on cheap official APIs", () => {
    expect(pollingTierFor({ priority: "standard", provider: "greenhouse", eeCpeFit: "High" })).toBe("A");
  });

  it("uses Tier B for other supported cheap boards and Tier C for expensive custom sites", () => {
    expect(pollingTierFor({ priority: "standard", provider: "workday", eeCpeFit: "Medium" })).toBe("B");
    expect(pollingTierFor({ priority: "priority", provider: "custom", eeCpeFit: "High" })).toBe("C");
  });
});
