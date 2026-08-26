import { describe, expect, it } from "vitest";
import { calculateFreshLatency, calculateRecall, classifyIcimsAccess, isSupportedReachable, rankMissingProviders } from "./providerQuality";

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

  it("locks the authoritative supported/reachable definition", () => {
    // No implementation could have fixed these — excluded from the denominator.
    for (const reasonCode of ["UNKNOWN_COMPANY", "NO_ATS_CONFIG", "NO_OFFICIAL_URL", "BOT_WALL_BLOCKED", "PROVIDER_ACCESS_BLOCKED", "POSTING_CLOSED"]) {
      expect(isSupportedReachable({ resolvedJobId: null, reasonCode })).toBe(false);
    }
    // A generically-fixable resolver miss — stays in the denominator.
    for (const reasonCode of ["ATS_BOARD_FETCH_FAILED", "NO_BOARD_MATCH", "BOARD_ROLE_NOT_INDEXED", "BOARD_WRONG_EMPLOYER", "TITLE_MATCH_TOO_LOW", "LOCATION_MISMATCH", "OFFICIAL_URL_REJECTED", "PARSER_FAILURE", "NETWORK_FAILURE", "RATE_LIMITED"]) {
      expect(isSupportedReachable({ resolvedJobId: null, reasonCode })).toBe(true);
    }
    // A resolved signal counts as supported/reachable regardless of any stale reasonCode.
    expect(isSupportedReachable({ resolvedJobId: "job_1", reasonCode: "NO_ATS_CONFIG" })).toBe(true);
  });

  it("ranks recent unresolved signal value ahead of alphabetical backlog", () => {
    expect(rankMissingProviders([
      { name: "Alpha", engineeringActivityTier: "C" },
      { name: "Zulu", engineeringActivityTier: "A", recentUnresolvedSignals: 3 },
    ])[0]?.name).toBe("Zulu");
  });
});
