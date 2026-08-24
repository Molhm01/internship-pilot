import { describe, expect, it } from "vitest";
import { calculateFreshLatency, calculateRecall, classifyIcimsAccess, rankMissingProviders } from "./providerQuality";

describe("provider quality diagnostics", () => {
  it("classifies and stops on an iCIMS bot wall", () => {
    expect(classifyIcimsAccess({ hasIdentifier: true, errorCode: "ATS_BOT_WALL" })).toBe("BOT_WALL");
  });

  it("calculates overall and supported recall without changing denominators", () => {
    const result = calculateRecall([
      { canonical: true, supportedReachable: true },
      { canonical: false, supportedReachable: true },
      { canonical: false, supportedReachable: false },
    ]);
    expect(result).toMatchObject({ overallDenominator: 3, overallCanonical: 1, supportedReachableDenominator: 2, supportedReachableCanonical: 1 });
    expect(result.overallRecall).toBeCloseTo(1 / 3);
    expect(result.supportedReachableRecall).toBe(0.5);
  });

  it("excludes historical rows from a new steady-state latency cohort", () => {
    const start = new Date("2026-08-24T12:00:00Z");
    const result = calculateFreshLatency([
      { sourceCapturedAt: new Date("2026-08-23T12:00:00Z"), officialResolutionStartedAt: new Date("2026-08-23T12:01:00Z"), canonicalStoredAt: new Date("2026-08-24T12:01:00Z"), supportedReachable: true },
      { sourceCapturedAt: new Date("2026-08-24T12:01:00Z"), officialResolutionStartedAt: new Date("2026-08-24T12:02:00Z"), canonicalStoredAt: new Date("2026-08-24T12:04:00Z"), supportedReachable: true },
    ], start);
    expect(result).toEqual({ cohortSize: 1, medianMs: 180_000, p90Ms: 180_000 });
  });

  it("ranks recent unresolved signal value ahead of alphabetical backlog", () => {
    expect(rankMissingProviders([
      { name: "Alpha", engineeringActivityTier: "C" },
      { name: "Zulu", engineeringActivityTier: "A", recentUnresolvedSignals: 3 },
    ])[0]?.name).toBe("Zulu");
  });
});
