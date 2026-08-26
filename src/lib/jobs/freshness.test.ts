import { describe, expect, it } from "vitest";
import { discoverFreshnessGroup, discoverFreshnessLabel } from "./freshness";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

describe("Discover freshness", () => {
  it("includes a newly discovered unknown-date job for at most 72 hours", () => {
    const job = { sourcePostedAt: null, firstSeenAt: ago(70) };
    expect(discoverFreshnessGroup(job, NOW)).toBe("UNKNOWN_DISCOVERED_LE_72H");
    expect(discoverFreshnessLabel(job, NOW)).toBe("NEWLY_DISCOVERED");
  });

  it("keeps old unknown-date backlog out of Fresh", () => {
    expect(discoverFreshnessGroup({ sourcePostedAt: null, firstSeenAt: ago(73) }, NOW))
      .toBe("NOT_FRESH");
  });

  it("uses known employer posting evidence instead of discovery time", () => {
    expect(discoverFreshnessGroup({ sourcePostedAt: ago(8 * 24), firstSeenAt: ago(1) }, NOW))
      .toBe("NOT_FRESH");
  });
});
