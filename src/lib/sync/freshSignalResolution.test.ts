// Quality gates for the fresh signal → official posting pipeline.
//
// These are the rules that, when broken, produce the failure this pipeline was
// rebuilt to fix: fresh signals arriving and nothing reaching Discover.

import { describe, expect, it } from "vitest";
import {
  asOfficialAtsJob,
  directOfficialUrlFrom,
  finalWorkflowState,
  findExistingOfficialMatch,
  formatFreshRadarDiagnostics,
  officialSearchDecision,
  shouldPromoteAfterProbe,
  type FreshRadarDiagnostics,
} from "@/lib/sync/jobrightFreshDiscovery";
import {
  classifyOfficialBoardMatch,
  OFFICIAL_BOARD_MATCH_THRESHOLD,
} from "@/lib/sync/officialBoardMatch";
import {
  FRESH_SIGNAL_REASONS,
  formatReasonCounts,
  isPermanentLikeReason,
  isTransientReason,
  nextAttemptDelayMs,
  normalizeCompanyKey,
} from "@/lib/sync/freshSignalReasons";
import {
  findApprovedCompany,
  providerConfigFromPublishedCareersUrl,
} from "@/lib/sync/employerBoardResolution";
import { canonicalizeJobUrl } from "@/lib/sync/ingest";
import type { RawInternListJob } from "@/lib/sync/internListAdapter";
import type { AtsJob } from "@/lib/ats/types";
import type { CompanyForListing } from "@/lib/ats";

function signal(overrides: Partial<RawInternListJob> = {}): RawInternListJob {
  return {
    sourceJobId: "abc123",
    title: "Software Engineering Intern",
    company: "Tenstorrent",
    location: "Austin, TX",
    workModel: "On Site",
    postedAt: new Date("2026-08-22T15:05:04Z"),
    sourcePostedAt: new Date("2026-08-22T15:05:04Z"),
    sourcePostedText: null,
    sourceDateConfidence: "EXACT",
    sourceRowIndex: 0,
    hireTime: null,
    salary: null,
    qualifications: "Strong background in digital design fundamentals.",
    applyUrl: "https://jobright.ai/jobs/info/abc123?utm_source=1099",
    sourceListingUrl: "https://jobright.ai/jobs/info/abc123",
    officialApplicationUrl: null,
    originalJobPostUrl: null,
    h1bSponsored: "Not Sure",
    ...overrides,
  };
}

function boardJob(overrides: Partial<AtsJob> = {}): AtsJob {
  return {
    sourceJobId: "gh-777",
    requisitionId: "REQ-777",
    title: "Software Engineering Intern",
    company: "Tenstorrent",
    location: "Austin, TX",
    workplaceType: "On Site",
    applyUrl: "https://boards.greenhouse.io/tenstorrent/jobs/777",
    description: "Full employer job description text, at least a paragraph long.",
    postedAt: new Date("2026-08-20T00:00:00Z"),
    postedAtText: null,
    ...overrides,
  };
}

describe("Gate 4 — an aggregator URL is never an Apply destination", () => {
  it("does not accept the feed row's own jobright.ai link as the official URL", () => {
    expect(directOfficialUrlFrom(signal())).toBeNull();
  });

  it("rejects every aggregator host, not just jobright", () => {
    for (const url of [
      "https://jobright.ai/jobs/info/abc123",
      "https://simplify.jobs/p/abc-123/Software-Intern",
      "https://www.intern-list.com/swe-intern-list/swe_intern_at_acme_1",
      "https://www.linkedin.com/jobs/view/12345",
      "https://www.indeed.com/viewjob?jk=abc",
    ]) {
      expect(directOfficialUrlFrom({ applyUrl: url })).toBeNull();
    }
  });

  it("never lets an aggregator posting on a board win the match", () => {
    const verdict = classifyOfficialBoardMatch(
      { title: "Software Engineering Intern", location: "Austin, TX" },
      [boardJob({ applyUrl: "https://jobright.ai/jobs/info/777" })],
    );
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.reason).toBe("OFFICIAL_URL_REJECTED");
  });
});

describe("Gate 5 — a direct official URL is accepted", () => {
  it("takes an employer ATS URL stated by the feed row", () => {
    expect(
      directOfficialUrlFrom(
        signal({ officialApplicationUrl: "https://job-boards.greenhouse.io/acme/jobs/4512" }),
      ),
    ).toBe("https://job-boards.greenhouse.io/acme/jobs/4512");
  });

  it("takes an employer-hosted job URL that embeds the requisition in a query", () => {
    expect(
      directOfficialUrlFrom({ applyUrl: "https://motional.com/open-positions/?gh_jid=98765" }),
    ).toBe("https://motional.com/open-positions/?gh_jid=98765");
  });

  it("prefers the explicit official URL over a weaker candidate", () => {
    expect(
      directOfficialUrlFrom({
        officialApplicationUrl: "https://jobs.lever.co/acme/aaa-bbb",
        originalJobPostUrl: "https://acme.com/careers/jobs/9",
        applyUrl: "https://jobright.ai/jobs/info/1",
      }),
    ).toBe("https://jobs.lever.co/acme/aaa-bbb");
  });
});

describe("Gate 6 — an unknown company enters automatic resolution", () => {
  const index = new Map<string, CompanyForListing>([
    [
      normalizeCompanyKey("Hubbell Incorporated"),
      {
        name: "Hubbell Incorporated",
        atsType: "workday",
        atsIdentifier: "hubbell.wd1/hubbell",
        careersUrl: "https://hubbell.com/careers",
        lastETag: null,
        lastModified: null,
        contentHash: null,
      },
    ],
  ]);

  it("does not silently drop an employer the approved CSV has never heard of", () => {
    // The pre-fix behaviour: no approved row meant the signal was counted as
    // one undifferentiated "unresolved" and thrown away. Now the absence of a
    // row is only the START of resolution.
    expect(findApprovedCompany("Tenstorrent", index)).toBeNull();
  });

  it("still recognises an approved employer across legal-form drift", () => {
    expect(findApprovedCompany("Hubbell Inc.", index)?.atsType).toBe("workday");
    expect(findApprovedCompany("Hubbell", index)?.atsType).toBe("workday");
  });

  it("normalizes company identity consistently across the pipeline", () => {
    expect(normalizeCompanyKey("Procter & Gamble")).toBe(normalizeCompanyKey("Procter and Gamble"));
    expect(normalizeCompanyKey("Acme Corp.")).toBe(normalizeCompanyKey("ACME Corporation"));
    expect(normalizeCompanyKey("Acme")).not.toBe(normalizeCompanyKey("Acumen"));
  });
});

describe("an employer-published provider URL outranks a weak cached page scan", () => {
  it("routes IBM's approved careers URL to IBM's observed public search adapter", () => {
    expect(
      providerConfigFromPublishedCareersUrl({
        name: "IBM",
        careersUrl: "https://www.ibm.com/careers",
        atsType: "custom",
        atsIdentifier: null,
      }),
    ).toMatchObject({
      atsType: "ibm-careers",
      atsIdentifier: "ibm",
      careersUrl: "https://www.ibm.com/careers",
      origin: "approved_company",
    });
  });

  it("does not invent a provider for a generic careers URL", () => {
    expect(
      providerConfigFromPublishedCareersUrl({
        name: "Acme",
        careersUrl: "https://acme.example/careers",
        atsType: "custom",
        atsIdentifier: null,
      }),
    ).toBeNull();
  });
});

describe("Gate 11 — duplicate signals collapse onto one job", () => {
  it("treats the same employer posting reached through different feeds as one URL", () => {
    const fromJobright = canonicalizeJobUrl(
      "https://boards.greenhouse.io/tenstorrent/jobs/777?utm_source=jobright&gh_src=abc",
    );
    const fromSimplify = canonicalizeJobUrl(
      "https://www.boards.greenhouse.io/tenstorrent/jobs/777/?ref=simplify",
    );
    const fromBoard = canonicalizeJobUrl("https://boards.greenhouse.io/tenstorrent/jobs/777");
    expect(fromJobright).toBe(fromBoard);
    expect(fromSimplify).toBe(fromBoard);
  });

  it("keeps two genuinely different postings on the same board apart", () => {
    expect(canonicalizeJobUrl("https://acme.com/careers/?gh_jid=1")).not.toBe(
      canonicalizeJobUrl("https://acme.com/careers/?gh_jid=2"),
    );
  });
});

describe("Gates 12 & 13 — closed vs merely unreachable", () => {
  it("does not promote a posting the destination confirmed closed", () => {
    expect(shouldPromoteAfterProbe("closed")).toBe(false);
  });

  it("promotes a posting whose availability check was inconclusive", () => {
    // A timeout, a 503, or a bot wall all produce "unknown". None of them is
    // evidence that a real internship disappeared.
    expect(shouldPromoteAfterProbe("unknown")).toBe(true);
    expect(shouldPromoteAfterProbe("open")).toBe(true);
  });

  it("retries a transient failure far sooner than a structural one", () => {
    expect(isTransientReason("NETWORK_FAILURE")).toBe(true);
    expect(isTransientReason("ATS_BOARD_FETCH_FAILED")).toBe(true);
    expect(isTransientReason("NO_ATS_CONFIG")).toBe(false);
    expect(nextAttemptDelayMs("NETWORK_FAILURE", 1)).toBeLessThan(
      nextAttemptDelayMs("NO_ATS_CONFIG", 1),
    );
  });

  it("never schedules a retry so far out that a signal is effectively dropped", () => {
    // Every reason stays on a bounded schedule — the point of the invariant is
    // that nothing is silently abandoned. The ceiling differs by class: an
    // employer whose careers site answers 404 to a real browser gets days
    // rather than hours, because retrying it sooner cannot change the answer
    // and spends budget a recoverable employer could have used.
    const ONE_DAY = 24 * 60 * 60 * 1000;
    for (const reason of FRESH_SIGNAL_REASONS) {
      const ceiling = isPermanentLikeReason(reason) ? 14 * ONE_DAY : ONE_DAY;
      expect(nextAttemptDelayMs(reason, 50), `${reason} must stay bounded`).toBeLessThanOrEqual(ceiling);
      expect(nextAttemptDelayMs(reason, 1), `${reason} must always retry`).toBeGreaterThan(0);
    }
  });
});

describe("Gate 14 — the job description always comes from the employer", () => {
  it("uses the board posting's own description", () => {
    const job = asOfficialAtsJob(signal(), "https://boards.greenhouse.io/x/jobs/1", boardJob());
    expect(job.description).toBe(boardJob().description);
  });

  it("REGRESSION: never synthesizes a JD from the feed's qualification bullets", () => {
    // Writing the aggregator's own summary into `description` made a
    // synthesized JD indistinguishable from a real one to the ATS scorer.
    const job = asOfficialAtsJob(signal(), "https://boards.greenhouse.io/x/jobs/1", null);
    expect(job.description).toBe("");
    expect(job.description).not.toContain("digital design");
  });

  it("uses the employer board date instead of a lower-authority radar timestamp", () => {
    const job = asOfficialAtsJob(signal(), "https://boards.greenhouse.io/x/jobs/1", boardJob());
    expect(job.postedAt?.toISOString()).toBe("2026-08-20T00:00:00.000Z");
  });
});

describe("official catalog priority trigger", () => {
  const canonical = {
    ...boardJob(),
    jobId: "canonical-job-1",
    provider: "greenhouse",
    hasEmployerJd: true,
  };
  const index = new Map([["tenstorrent", [canonical]]]);

  it("matches a fresh signal to an already-existing canonical official job", () => {
    expect(findExistingOfficialMatch(signal(), index)?.jobId).toBe("canonical-job-1");
    expect(officialSearchDecision(signal(), index).action).toBe("attach_existing");
  });

  it("queues an immediate priority crawl when the canonical job is missing", () => {
    expect(officialSearchDecision(signal({ company: "Unindexed Robotics" }), index)).toEqual({
      action: "priority_crawl",
    });
  });

  it("allows multiple radar signals to attach to one canonical job identity", () => {
    const first = findExistingOfficialMatch(signal({ sourceJobId: "signal-a" }), index);
    const second = findExistingOfficialMatch(signal({ sourceJobId: "signal-b" }), index);
    expect(first?.jobId).toBe(second?.jobId);
  });

  it("maps retryable failures to a durable transient state", () => {
    expect(finalWorkflowState("PENDING", "NETWORK_FAILURE")).toBe("TRANSIENT_FAILURE");
    expect(finalWorkflowState("PENDING", "NO_BOARD_MATCH")).toBe("NO_MATCH_YET");
    expect(finalWorkflowState("RESOLVED")).toBe("OFFICIAL_RESOLVED");
  });
});

describe("board-match rejection reasons are specific", () => {
  const discovery = { title: "Software Engineering Intern", location: "Austin, TX" };

  it("reports NO_BOARD_MATCH for an empty board", () => {
    const verdict = classifyOfficialBoardMatch(discovery, []);
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.reason).toBe("NO_BOARD_MATCH");
  });

  it("reports NO_BOARD_MATCH when nothing on the board resembles the signal", () => {
    const verdict = classifyOfficialBoardMatch(discovery, [
      boardJob({ title: "Senior Accountant" }),
      boardJob({ title: "Facilities Manager" }),
    ]);
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.reason).toBe("NO_BOARD_MATCH");
  });

  it("reports LOCATION_MISMATCH when the title matches in a conflicting state", () => {
    const verdict = classifyOfficialBoardMatch(discovery, [
      boardJob({ location: "Boston, MA" }),
    ]);
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.reason).toBe("LOCATION_MISMATCH");
  });

  it("reports TITLE_MATCH_TOO_LOW for a partial title overlap under the bar", () => {
    // Both titles carry a distinctive token the other lacks ("controls" vs
    // "thermal"), so neither contains the other: 4 of 6 shared = 0.67, above the
    // 0.55 "worth diagnosing" floor but below the 0.72 accept bar.
    const verdict = classifyOfficialBoardMatch(
      { title: "Mechanical Engineering Intern Robotics Controls", location: "Austin, TX" },
      [
        boardJob({
          title: "Mechanical Engineering Intern Robotics Thermal Systems",
          location: "Remote",
        }),
      ],
    );
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) {
      expect(verdict.reason).toBe("TITLE_MATCH_TOO_LOW");
      expect(verdict.bestScore).toBeLessThan(OFFICIAL_BOARD_MATCH_THRESHOLD);
    }
  });

  it("accepts the real counterpart", () => {
    const verdict = classifyOfficialBoardMatch(discovery, [
      boardJob({ title: "Facilities Manager" }),
      boardJob(),
    ]);
    expect(verdict.accepted).toBe(true);
    if (verdict.accepted) expect(verdict.job.applyUrl).toBe(boardJob().applyUrl);
  });
});

describe("Gate 10 (observability) — unresolved is never one generic bucket", () => {
  it("renders every distinct reason with its count, busiest first", () => {
    expect(
      formatReasonCounts({ NO_ATS_CONFIG: 3, NETWORK_FAILURE: 1, NO_BOARD_MATCH: 9 }),
    ).toBe("NO_BOARD_MATCH=9 NO_ATS_CONFIG=3 NETWORK_FAILURE=1");
  });

  it("puts the reason breakdown in the radar's own summary line", () => {
    const diagnostics: FreshRadarDiagnostics = {
      categoriesAttempted: 3,
      categoryCounts: { engineering_development: 50 },
      signalsFetched: 312,
      under24h: 88,
      under72h: 171,
      examined: 312,
      alreadyResolved: 0,
      alreadyFoundOfficial: 0,
      deferred: 0,
      officialUrlDirect: 54,
      sourceOriginalPost: 0,
      companyResolved: 40,
      boardResolved: 91,
      unresolved: 26,
      closed: 7,
      duplicates: 64,
      newJobs: 43,
      updatedJobs: 21,
      medianResolutionMs: 1800,
      reasonCounts: { NO_ATS_CONFIG: 20, NETWORK_FAILURE: 6 },
      providerCounts: { workday: 60, greenhouse: 45, eightfold: 25, phenom: 15 },
      resolvedWithJd: 120,
      stoppedForTimeBudget: false,
    };
    const line = formatFreshRadarDiagnostics(diagnostics);
    expect(line).toContain("signals=312");
    expect(line).toContain("<24h=88");
    expect(line).toContain("boardResolved=91");
    expect(line).toContain("unresolved=26");
    expect(line).toContain("closed=7");
    expect(line).toContain("duplicates=64");
    expect(line).toContain("new=43");
    expect(line).toContain("medianResolutionMs=1800");
    expect(line).toContain("NO_ATS_CONFIG=20");
  });

  it("reports a resolution percentage rather than leaving it to be inferred", () => {
    const line = formatFreshRadarDiagnostics({
      categoriesAttempted: 1,
      categoryCounts: {},
      signalsFetched: 10,
      under24h: 10,
      under72h: 10,
      examined: 10,
      alreadyResolved: 0,
      alreadyFoundOfficial: 0,
      deferred: 0,
      officialUrlDirect: 2,
      sourceOriginalPost: 1,
      companyResolved: 4,
      boardResolved: 5,
      unresolved: 2,
      closed: 0,
      duplicates: 0,
      newJobs: 8,
      updatedJobs: 0,
      medianResolutionMs: null,
      reasonCounts: {},
      providerCounts: { greenhouse: 5, phenom: 3 },
      resolvedWithJd: 6,
      stoppedForTimeBudget: false,
    });
    expect(line).toContain("resolved=8 (80%)");
  });
});

describe("a verified public-access block is its own retry class", () => {
  it("backs off for days, not minutes — and never abandons the employer", () => {
    // A provider confirmed inaccessible in a real browser should not consume
    // the fresh lane every hour; retrying today cannot change that answer.
    const first = nextAttemptDelayMs("PROVIDER_ACCESS_BLOCKED", 1);
    const later = nextAttemptDelayMs("PROVIDER_ACCESS_BLOCKED", 5);

    expect(first).toBeGreaterThanOrEqual(3 * 24 * 60 * 60 * 1000);
    expect(later).toBeGreaterThan(first);
    // Bounded: a careers site can come back, so this never becomes "never".
    expect(nextAttemptDelayMs("PROVIDER_ACCESS_BLOCKED", 999)).toBeLessThanOrEqual(
      14 * 24 * 60 * 60 * 1000,
    );
  });

  it("waits far longer than an ordinary structural miss or a transient one", () => {
    expect(nextAttemptDelayMs("PROVIDER_ACCESS_BLOCKED", 1)).toBeGreaterThan(
      nextAttemptDelayMs("NO_ATS_CONFIG", 1),
    );
    expect(nextAttemptDelayMs("NO_ATS_CONFIG", 1)).toBeGreaterThan(
      nextAttemptDelayMs("NETWORK_FAILURE", 1),
    );
  });

  it("is not classed as transient, so an empty read is never read as a closure", () => {
    expect(isTransientReason("PROVIDER_ACCESS_BLOCKED")).toBe(false);
    expect(isPermanentLikeReason("PROVIDER_ACCESS_BLOCKED")).toBe(true);
    expect(isPermanentLikeReason("NO_ATS_CONFIG")).toBe(false);
  });
});
