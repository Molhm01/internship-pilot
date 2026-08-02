import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const scheduleInitialAiMatch = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { job: { findMany: (...args: unknown[]) => findMany(...args) } },
}));

vi.mock("@/lib/matching/initialAiMatchQueue", () => ({
  scheduleInitialAiMatch: (...args: unknown[]) => scheduleInitialAiMatch(...args),
}));

import { backfillUnscoredInitialMatches } from "./initialBackfill";

describe("manual unscored INITIAL-match backfill", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    findMany.mockResolvedValue([{ id: "unscored-1" }, { id: "unscored-2" }]);
    scheduleInitialAiMatch.mockResolvedValue({ scheduled: true, reason: "SCHEDULED" });
  });

  it("dry-runs only jobs without a valid score or active INITIAL work", async () => {
    await expect(backfillUnscoredInitialMatches({ batchSize: 2, dryRun: true })).resolves.toEqual({
      selected: 2,
      scheduled: 0,
      skipped: 0,
      dryRun: true,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        matchResults: { none: { score: { gte: 0, lte: 100 } } },
        initialAiMatchJobs: {
          none: { matchType: "INITIAL", state: { in: ["PENDING", "RUNNING"] } },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 2,
      select: { id: true },
    });
    expect(scheduleInitialAiMatch).not.toHaveBeenCalled();
  });

  it("schedules only the bounded selected fixture batch when explicitly executed", async () => {
    await expect(backfillUnscoredInitialMatches({ batchSize: 2, dryRun: false })).resolves.toEqual({
      selected: 2,
      scheduled: 2,
      skipped: 0,
      dryRun: false,
    });
    expect(scheduleInitialAiMatch).toHaveBeenCalledTimes(2);
  });
});
