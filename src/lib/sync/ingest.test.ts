import { beforeEach, describe, expect, it, vi } from "vitest";

const jobFindFirst = vi.fn();
const jobFindMany = vi.fn();
const jobFindUnique = vi.fn();
const jobCreate = vi.fn();
const jobUpdate = vi.fn();
const companyFindFirst = vi.fn();
const resumeFactFindMany = vi.fn();
const userJobStateFindMany = vi.fn();
const userJobStateCreateMany = vi.fn();
const transaction = vi.fn();
const scheduleInitialAiMatch = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    job: {
      findFirst: (...args: unknown[]) => jobFindFirst(...args),
      findMany: (...args: unknown[]) => jobFindMany(...args),
      findUnique: (...args: unknown[]) => jobFindUnique(...args),
      create: (...args: unknown[]) => jobCreate(...args),
      update: (...args: unknown[]) => jobUpdate(...args),
    },
    company: { findFirst: (...args: unknown[]) => companyFindFirst(...args) },
    resumeFact: { findMany: (...args: unknown[]) => resumeFactFindMany(...args) },
    userJobState: {
      findMany: (...args: unknown[]) => userJobStateFindMany(...args),
      createMany: (...args: unknown[]) => userJobStateCreateMany(...args),
    },
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}));

vi.mock("@/lib/applications/officialDestination", () => ({
  isAggregatorUrl: () => false,
  // The canonical Apply URL is written through this; the real implementation
  // strips aggregator attribution, and the identity stub keeps these fixtures
  // measuring ingestion rather than URL cleaning.
  stripTrackingParameters: (value: string) => value,
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

// Discovery has no user in scope, so ingest fans the automatic first score
// out to every eligible account instead of scheduling one globally.
vi.mock("@/lib/matching/initialAiMatchQueue", () => ({
  scheduleInitialAiMatchForAllUsers: (...args: unknown[]) => scheduleInitialAiMatch(...args),
}));

import { ingestAtsJobs, upsertClassifiedAtsJob } from "./ingest";

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
    jobFindUnique.mockResolvedValue(null);
    companyFindFirst.mockResolvedValue(null);
    resumeFactFindMany.mockResolvedValue([
      { id: "fact-1", userId: "candidate-1", type: "skill", content: "Embedded Python", detail: null },
    ]);
    userJobStateFindMany.mockResolvedValue([]);
    userJobStateCreateMany.mockResolvedValue({ count: 1 });
    jobCreate.mockResolvedValue({ id: "job-new" });
    jobUpdate.mockResolvedValue({});
    transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback({
      job: { create: (...args: unknown[]) => jobCreate(...args) },
      userJobState: { createMany: (...args: unknown[]) => userJobStateCreateMany(...args) },
    }));
    scheduleInitialAiMatch.mockResolvedValue({ scheduled: true, reason: "SCHEDULED" });
  });

  it("queues exactly one INITIAL match without starting model work in discovery", async () => {
    await expect(upsertClassifiedAtsJob({
      job: importedJob,
      source: "greenhouse",
      atsType: "greenhouse",
      atsTenant: "signal-labs",
      classification: "QUALIFYING_INTERNSHIP",
      classificationReason: "Official board engineering internship.",
    })).resolves.toBe("new");
    expect(jobCreate).toHaveBeenCalledOnce();
    expect(scheduleInitialAiMatch).toHaveBeenCalledOnce();
    expect(scheduleInitialAiMatch).toHaveBeenCalledWith("job-new", { startWorker: false });
    expect(jobCreate.mock.invocationCallOrder[0]).toBeLessThan(scheduleInitialAiMatch.mock.invocationCallOrder[0]);
  });

  it("discovers an official board job without any radar source", async () => {
    await expect(upsertClassifiedAtsJob({
      job: importedJob,
      source: "greenhouse",
      atsType: "greenhouse",
      atsTenant: "signal-labs",
      classification: "QUALIFYING_INTERNSHIP",
      classificationReason: "Official board engineering internship.",
    })).resolves.toBe("new");
    expect(jobCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        source: "greenhouse",
        atsType: "greenhouse",
        verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
        activeFeed: true,
      }),
    }));
  });

  it("lets bounded discovery diagnostics ingest without queueing model work", async () => {
    await upsertClassifiedAtsJob({
      job: importedJob,
      source: "workday",
      atsType: "workday",
      atsTenant: "signal/External",
      classification: "QUALIFYING_INTERNSHIP",
      classificationReason: "Validated board role.",
      scheduleInitialMatch: false,
    });
    expect(jobCreate).toHaveBeenCalledOnce();
    expect(scheduleInitialAiMatch).not.toHaveBeenCalled();
  });

  it("does not spend AI queue capacity on an unverified discovery signal", async () => {
    await expect(ingestAtsJobs([importedJob], "intern-list")).resolves.toEqual({
      newCount: 1,
      updatedCount: 0,
    });
    expect(jobCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ activeFeed: false }),
    }));
    expect(scheduleInitialAiMatch).not.toHaveBeenCalled();
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

  it("updates a hydrated JD while preserving the canonical official job identity", async () => {
    jobFindFirst.mockResolvedValue({
      id: "job-existing",
      title: importedJob.title,
      company: importedJob.company,
      location: importedJob.location,
      description: "",
      source: "greenhouse",
      sourceJobId: importedJob.sourceJobId,
      requisitionId: null,
      sourceUrl: importedJob.applyUrl,
      officialApplicationUrl: "https://employer.example/jobs/1",
      resolutionStatus: "RESOLVED",
      verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
      atsType: "greenhouse",
      atsTenant: "signal-labs",
      sourcePostedAt: importedJob.postedAt,
      sourceDateConfidence: "DATE_ONLY",
      sourceDateProvenance: "EMPLOYER_ATS_DATE",
      closedAt: null,
    });

    await upsertClassifiedAtsJob({
      job: importedJob,
      source: "greenhouse",
      atsType: "greenhouse",
      atsTenant: "signal-labs",
      classification: "QUALIFYING_INTERNSHIP",
      classificationReason: "Official board engineering internship.",
    });
    expect(jobUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "job-existing" },
      data: expect.objectContaining({ description: importedJob.description }),
    }));
    expect(jobCreate).not.toHaveBeenCalled();
  });

  it("keeps ingestion successful when background scheduling cannot start", async () => {
    scheduleInitialAiMatch.mockRejectedValue(new Error("Ollama offline or queue unavailable"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(upsertClassifiedAtsJob({
      job: importedJob,
      source: "greenhouse",
      atsType: "greenhouse",
      atsTenant: "signal-labs",
      classification: "QUALIFYING_INTERNSHIP",
      classificationReason: "Official board engineering internship.",
    })).resolves.toBe("new");
    expect(jobCreate).toHaveBeenCalledOnce();
    expect(userJobStateCreateMany).toHaveBeenCalledWith({ data: [
      expect.objectContaining({
        userId: "candidate-1",
        jobId: "job-new",
        matchScore: expect.any(Number),
        scoreSource: "BASELINE",
      }),
    ] });
    const state = userJobStateCreateMany.mock.calls[0][0].data[0];
    expect(Number.isInteger(state.matchScore)).toBe(true);
    expect(errorLog).toHaveBeenCalledWith(
      "[ingest] initial AI Match scheduling failed",
      { jobId: "job-new", errorCode: "SCHEDULE_FAILED" },
    );
    errorLog.mockRestore();
  });
});
