import { beforeEach, describe, expect, it, vi } from "vitest";

const jobFindFirst = vi.fn();
const jobFindMany = vi.fn();
const jobCreate = vi.fn();
const jobUpdate = vi.fn();
const companyFindFirst = vi.fn();
const scheduleInitialAiMatch = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    job: {
      findFirst: (...args: unknown[]) => jobFindFirst(...args),
      findMany: (...args: unknown[]) => jobFindMany(...args),
      create: (...args: unknown[]) => jobCreate(...args),
      update: (...args: unknown[]) => jobUpdate(...args),
    },
    company: { findFirst: (...args: unknown[]) => companyFindFirst(...args) },
  },
}));

vi.mock("@/lib/applications/officialDestination", () => ({
  isAggregatorUrl: () => false,
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
  scheduleInitialAiMatch: (...args: unknown[]) => scheduleInitialAiMatch(...args),
}));

import { ingestAtsJobs } from "./ingest";

const importedJob = {
  sourceJobId: "source-1",
  requisitionId: null,
  title: "Firmware Engineering Intern",
  company: "Signal Labs",
  location: "Newark, NJ",
  postedAt: new Date("2026-08-01T00:00:00.000Z"),
  description: "Build and test embedded firmware, analyze device data, document results, and collaborate with engineers throughout the product lifecycle.",
  applyUrl: "https://employer.example/jobs/1",
  workplaceType: "Hybrid",
};

describe("job ingestion INITIAL AI Match trigger", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    jobFindFirst.mockResolvedValue(null);
    jobFindMany.mockResolvedValue([]);
    companyFindFirst.mockResolvedValue(null);
    jobCreate.mockResolvedValue({ id: "job-new" });
    jobUpdate.mockResolvedValue({});
    scheduleInitialAiMatch.mockResolvedValue({ scheduled: true, reason: "SCHEDULED" });
  });

  it("schedules exactly one INITIAL match only after a genuinely new job is persisted", async () => {
    await expect(ingestAtsJobs([importedJob], "ats:greenhouse")).resolves.toEqual({
      newCount: 1,
      updatedCount: 0,
    });
    expect(jobCreate).toHaveBeenCalledOnce();
    expect(scheduleInitialAiMatch).toHaveBeenCalledOnce();
    expect(scheduleInitialAiMatch).toHaveBeenCalledWith("job-new");
    expect(jobCreate.mock.invocationCallOrder[0]).toBeLessThan(scheduleInitialAiMatch.mock.invocationCallOrder[0]);
  });

  it("does not schedule when an existing job is rediscovered or updated", async () => {
    jobFindFirst.mockResolvedValue({
      id: "job-existing",
      title: importedJob.title,
      company: importedJob.company,
      location: importedJob.location,
      description: "old description",
      sourceUrl: importedJob.applyUrl,
      officialApplicationUrl: "https://employer.example/jobs/1",
      resolutionStatus: "RESOLVED",
      verificationStatus: "Pending",
    });

    await expect(ingestAtsJobs([importedJob], "ats:greenhouse")).resolves.toEqual({
      newCount: 0,
      updatedCount: 1,
    });
    expect(jobUpdate).toHaveBeenCalledOnce();
    expect(jobCreate).not.toHaveBeenCalled();
    expect(scheduleInitialAiMatch).not.toHaveBeenCalled();
  });

  it("keeps ingestion successful when background scheduling cannot start", async () => {
    scheduleInitialAiMatch.mockRejectedValue(new Error("Ollama offline or queue unavailable"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(ingestAtsJobs([importedJob], "ats:greenhouse")).resolves.toEqual({
      newCount: 1,
      updatedCount: 0,
    });
    expect(jobCreate).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith(
      "[ingest] initial AI Match scheduling failed",
      { jobId: "job-new", errorCode: "SCHEDULE_FAILED" },
    );
    errorLog.mockRestore();
  });
});
