import { beforeEach, describe, expect, it, vi } from "vitest";

const jobFindFirst = vi.fn();
const jobFindMany = vi.fn();
const jobCreate = vi.fn();
const jobUpdate = vi.fn();
const companyFindFirst = vi.fn();
const companyFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    job: {
      findFirst: (...args: unknown[]) => jobFindFirst(...args),
      findMany: (...args: unknown[]) => jobFindMany(...args),
      create: (...args: unknown[]) => jobCreate(...args),
      update: (...args: unknown[]) => jobUpdate(...args),
    },
    company: {
      findFirst: (...args: unknown[]) => companyFindFirst(...args),
      findMany: (...args: unknown[]) => companyFindMany(...args),
    },
  },
}));

vi.mock("@/lib/applications/officialDestination", () => ({
  isAggregatorUrl: () => false,
  isValidOfficialApplicationUrl: (url: unknown) => typeof url === "string" && url.startsWith("https://"),
  resolveOfficialJobDestination: vi.fn().mockResolvedValue({
    sourceListingUrl: null,
    officialApplicationUrl: "https://employer.example/jobs/1",
    originalJobPostUrl: null,
    resolutionStatus: "RESOLVED",
  }),
  destinationPersistenceData: () => ({
    sourceListingUrl: null,
    officialApplicationUrl: "https://employer.example/jobs/1",
    resolutionStatus: "RESOLVED",
  }),
}));

vi.mock("@/lib/matching/initialAiMatchQueue", () => ({
  scheduleInitialAiMatch: vi.fn().mockResolvedValue({ scheduled: true, reason: "SCHEDULED" }),
}));

import { ingestAtsJobs, ingestJobs } from "./ingest";
import { parseInternListPayload, type RawInternListJob } from "./internListAdapter";

const CAPTURED_AT = new Date("2026-08-01T12:00:00.000Z");

function payload(...jobs: Record<string, unknown>[]) {
  return {
    props: {
      pageProps: {
        initialJobs: jobs.map((j, i) => ({
          id: `job-${i}`,
          title: "Engineering Intern",
          company: "Acme",
          qualifications: "Embedded C, oscilloscopes, and lab documentation for a real product team.",
          ...j,
        })),
      },
    },
  };
}

const createdData = () => jobCreate.mock.calls[0][0].data;
const updatedData = () => jobUpdate.mock.calls[0][0].data;

describe("InternList extraction of the source posting date", () => {
  it("resolves relative source text against the sync capture time", () => {
    const jobs = parseInternListPayload(
      payload({ postedDateText: "38 minutes ago" }, { postedDateText: "4 hours ago" }),
      CAPTURED_AT,
    );
    expect(jobs[0].sourcePostedAt?.toISOString()).toBe("2026-08-01T11:22:00.000Z");
    expect(jobs[0].sourcePostedText).toBe("38 minutes ago");
    expect(jobs[0].sourceDateConfidence).toBe("RELATIVE_PARSED");
    expect(jobs[1].sourcePostedAt?.toISOString()).toBe("2026-08-01T08:00:00.000Z");
  });

  it("reads the minisite's epoch postedDate as an exact instant", () => {
    const [job] = parseInternListPayload(
      payload({ postedDate: Date.UTC(2026, 7, 1, 11, 4, 25) }),
      CAPTURED_AT,
    );
    expect(job.sourcePostedAt?.toISOString()).toBe("2026-08-01T11:04:25.000Z");
    expect(job.sourceDateConfidence).toBe("EXACT");
  });

  it("preserves the source's row order", () => {
    const jobs = parseInternListPayload(payload({}, {}, {}), CAPTURED_AT);
    expect(jobs.map((j) => j.sourceRowIndex)).toEqual([0, 1, 2]);
  });

  it("marks a row with no usable date as UNKNOWN instead of guessing", () => {
    const [job] = parseInternListPayload(payload({ postedDateText: "Rolling" }), CAPTURED_AT);
    expect(job.sourcePostedAt).toBeNull();
    expect(job.sourceDateConfidence).toBe("UNKNOWN");
  });
});

function rawJob(overrides: Partial<RawInternListJob> = {}): RawInternListJob {
  return {
    sourceJobId: "source-1",
    title: "Firmware Engineering Intern",
    company: "Signal Labs",
    location: "Newark, NJ",
    workModel: "Hybrid",
    postedAt: new Date("2026-08-01T11:22:00.000Z"),
    sourcePostedAt: new Date("2026-08-01T11:22:00.000Z"),
    sourcePostedText: "38 minutes ago",
    sourceDateConfidence: "RELATIVE_PARSED",
    sourceRowIndex: 0,
    hireTime: "2027-Summer",
    salary: null,
    qualifications: "Build and test embedded firmware with a real product team.",
    applyUrl: "https://employer.example/jobs/1",
    h1bSponsored: null,
    ...overrides,
  };
}

describe("persisting the canonical source posting date", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobFindFirst.mockResolvedValue(null);
    jobFindMany.mockResolvedValue([]);
    companyFindFirst.mockResolvedValue(null);
    // The strict discovery boundary requires an allowlisted employer.
    companyFindMany.mockResolvedValue([{ name: "Signal Labs" }]);
    jobCreate.mockResolvedValue({ id: "job-new" });
    jobUpdate.mockResolvedValue({});
  });

  it("stores sourcePostedAt, its wording, its confidence and the sync context", async () => {
    await ingestJobs([rawJob()], { syncRunId: "sync-1", capturedAt: CAPTURED_AT });

    expect(createdData()).toMatchObject({
      sourcePostedAt: new Date("2026-08-01T11:22:00.000Z"),
      sourcePostedText: "38 minutes ago",
      sourceDateConfidence: "RELATIVE_PARSED",
      sourceCapturedAt: CAPTURED_AT,
      sourceSyncRunId: "sync-1",
      sourceRowIndex: 0,
    });
    // The legacy filter column stays in step with the canonical field.
    expect(createdData().postingDate).toEqual(new Date("2026-08-01T11:22:00.000Z"));
  });

  it("keeps sourcePostedAt stable when the same job is seen by a later sync", async () => {
    jobFindFirst.mockResolvedValue({
      id: "job-existing",
      title: "Firmware Engineering Intern",
      company: "Signal Labs",
      description: "Build and test embedded firmware with a real product team.",
      sourceUrl: "https://employer.example/jobs/1",
      officialApplicationUrl: "https://employer.example/jobs/1",
      resolutionStatus: "RESOLVED",
      sourcePostedAt: new Date("2026-07-01T10:00:00.000Z"),
      sourceDateConfidence: "RELATIVE_PARSED",
    });

    // A later sync re-reads the same "38 minutes ago" wording. Naively
    // re-parsing it would walk the posting date forward to today.
    await ingestJobs([rawJob({ sourcePostedAt: new Date("2026-09-01T11:22:00.000Z") })], {
      syncRunId: "sync-2",
      capturedAt: new Date("2026-09-01T12:00:00.000Z"),
    });

    expect(jobCreate).not.toHaveBeenCalled();
    expect(updatedData()).not.toHaveProperty("sourcePostedAt");
    // Sync context IS refreshed, so row-order fallback follows the newest sync.
    expect(updatedData()).toMatchObject({ sourceSyncRunId: "sync-2", sourceRowIndex: 0 });
  });

  it("upgrades a stored relative date when the source later provides an exact one", async () => {
    jobFindFirst.mockResolvedValue({
      id: "job-existing",
      title: "Firmware Engineering Intern",
      company: "Signal Labs",
      description: "Build and test embedded firmware with a real product team.",
      sourcePostedAt: new Date("2026-07-01T10:00:00.000Z"),
      sourceDateConfidence: "RELATIVE_PARSED",
    });

    await ingestJobs(
      [rawJob({
        sourcePostedAt: new Date("2026-07-01T09:15:00.000Z"),
        sourcePostedText: null,
        sourceDateConfidence: "EXACT",
      })],
      { syncRunId: "sync-3", capturedAt: CAPTURED_AT },
    );

    expect(updatedData()).toMatchObject({
      sourcePostedAt: new Date("2026-07-01T09:15:00.000Z"),
      sourceDateConfidence: "EXACT",
    });
  });

  it("parses an ATS vendor's relative posting text against the capture time", async () => {
    await ingestAtsJobs(
      [{
        sourceJobId: "wd-1",
        title: "Engineering Intern",
        company: "Signal Labs",
        location: "Newark, NJ",
        workplaceType: null,
        applyUrl: "https://employer.example/jobs/1",
        description: "A real posting description with enough text to be usable.",
        postedAt: null,
        postedAtText: "Posted 3 Days Ago",
      }],
      "workday",
      { syncRunId: "ats-run-1", capturedAt: CAPTURED_AT },
    );

    expect(createdData()).toMatchObject({
      sourcePostedAt: new Date("2026-07-29T12:00:00.000Z"),
      sourceDateConfidence: "RELATIVE_PARSED",
      sourceSyncRunId: "ats-run-1",
      sourceRowIndex: 0,
    });
  });

  it("records an ATS posting with no date at all as UNKNOWN, not as now", async () => {
    await ingestAtsJobs(
      [{
        sourceJobId: "gen-1",
        title: "Engineering Intern",
        company: "Signal Labs",
        location: null,
        workplaceType: null,
        applyUrl: "https://employer.example/jobs/1",
        description: "A real posting description with enough text to be usable.",
        postedAt: null,
      }],
      "generic",
      { syncRunId: "ats-run-2", capturedAt: CAPTURED_AT },
    );

    expect(createdData().sourcePostedAt).toBeNull();
    expect(createdData().sourceDateConfidence).toBe("UNKNOWN");
  });
});
