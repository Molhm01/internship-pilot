import { beforeEach, describe, expect, it, vi } from "vitest";

const updateJob = vi.fn();
const baseline = vi.fn();
const scheduleAi = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { job: { update: (...args: unknown[]) => updateJob(...args) } },
}));
vi.mock("@/lib/matching/baselineScoring", () => ({
  baselineScoreJobForAllEligibleUsers: (...args: unknown[]) => baseline(...args),
}));
vi.mock("@/lib/matching/initialAiMatchQueue", () => ({
  scheduleInitialAiMatchForAllUsers: (...args: unknown[]) => scheduleAi(...args),
}));

import {
  applyOfficialHydrationEvidence,
  ashbyPostingIdFromUrl,
  hydrationPriority,
  type HydrationJob,
} from "./jobDescriptionHydration";

const NOW = new Date("2026-08-24T12:00:00.000Z");

function job(overrides: Partial<HydrationJob> = {}): HydrationJob {
  return {
    id: "job-1",
    title: "Software Engineering Intern",
    company: "Acme",
    description: "thin",
    jobResponsibilities: null,
    jobQualifications: null,
    officialJobUrl: "https://jobs.acme.example/1",
    originalJobPostUrl: null,
    officialApplicationUrl: "https://jobs.acme.example/1",
    officialApplyUrl: null,
    url: "https://jobs.acme.example/1",
    resolutionStatus: "RESOLVED",
    verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
    atsType: "workday",
    atsTenant: "acme.wd1/External",
    sourceJobId: "/job/1",
    scoringError: null,
    scoringQueuedAt: null,
    sourcePostedAt: null,
    sourcePostedText: null,
    sourceDateConfidence: "UNKNOWN",
    sourceDateProvenance: "UNKNOWN",
    firstSeenAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateJob.mockResolvedValue({ id: "job-1" });
  baseline.mockResolvedValue(1);
  scheduleAi.mockResolvedValue({ scheduled: 1 });
});

describe("official quality hydration", () => {
  it("prioritizes a newly discovered thin job ahead of old backlog", () => {
    expect(hydrationPriority(job(), NOW)).toBeLessThan(hydrationPriority(job({
      firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    }), NOW));
  });

  it("updates the JD fingerprint inputs, refreshes baseline, and queues AI without nulling score", async () => {
    const description = "Responsibilities qualifications skills and experience. ".repeat(20);
    const result = await applyOfficialHydrationEvidence(
      job(),
      "https://jobs.acme.example/1",
      {
        description,
        sourceDate: {
          sourcePostedAt: new Date("2026-08-23T10:30:00Z"),
          sourcePostedText: "2026-08-23T10:30:00Z",
          sourceDateConfidence: "EXACT",
        },
        sourceDateProvenance: "EMPLOYER_ATS_EXACT",
      },
      NOW,
    );

    expect(result).toEqual({ descriptionHydrated: true, dateHydrated: true, failed: false });
    const data = updateJob.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.jobDescriptionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data.sourcePostedAt).toEqual(new Date("2026-08-23T10:30:00Z"));
    expect(data).not.toHaveProperty("matchScore");
    expect(baseline).toHaveBeenCalledWith("job-1");
    expect(scheduleAi).toHaveBeenCalledWith("job-1", { startWorker: false });
    expect(baseline.mock.invocationCallOrder[0]).toBeLessThan(scheduleAi.mock.invocationCallOrder[0]);
  });

  it("reads Ashby's own posting UUID out of the job URL instead of a third-party aggregator id", () => {
    // A job discovered via an aggregator (Simplify, "zapply:", "dreamwork:", ...)
    // stores THAT service's id in sourceJobId — it never matches an Ashby
    // posting id. Ashby's own id is a UUID embedded in the job/apply URL.
    expect(ashbyPostingIdFromUrl(
      "https://jobs.ashbyhq.com/replit/7e0dafe8-3eec-442e-aa76-a4d84d779fb1/application?embed=true&utm_source=Simplify",
    )).toBe("7e0dafe8-3eec-442e-aa76-a4d84d779fb1");
  });

  it("returns null when no UUID is present in the URL", () => {
    expect(ashbyPostingIdFromUrl("https://jobs.ashbyhq.com/replit")).toBeNull();
    expect(ashbyPostingIdFromUrl(null)).toBeNull();
  });
});
