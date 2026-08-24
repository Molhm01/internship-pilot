import { describe, expect, it } from "vitest";
import { nextCheckTimeForFailure } from "./companyDiscovery";

describe("provider access backoff", () => {
  it("backs an iCIMS bot wall off independently of the five-minute fresh lane", () => {
    const now = new Date("2026-08-24T12:00:00Z");
    expect(nextCheckTimeForFailure("priority", 1, "icims", "ATS_BOT_WALL", now).getTime() - now.getTime())
      .toBe(12 * 60 * 60 * 1000);
    expect(nextCheckTimeForFailure("priority", 5, "icims", "ATS_BOT_WALL", now).getTime() - now.getTime())
      .toBeGreaterThan(12 * 60 * 60 * 1000);
  });
});
