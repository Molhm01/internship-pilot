import { prisma } from "@/lib/db";
import { scheduleInitialAiMatch } from "@/lib/matching/initialAiMatchQueue";

export type InitialBackfillOptions = {
  batchSize: number;
  dryRun: boolean;
};

export type InitialBackfillCounts = {
  selected: number;
  scheduled: number;
  skipped: number;
  dryRun: boolean;
};

export function normalizeBackfillBatchSize(value: number): number {
  if (!Number.isFinite(value)) return 25;
  return Math.max(1, Math.min(100, Math.trunc(value)));
}

export async function backfillUnscoredInitialMatches(
  options: InitialBackfillOptions,
): Promise<InitialBackfillCounts> {
  const batchSize = normalizeBackfillBatchSize(options.batchSize);
  const jobs = await prisma.job.findMany({
    where: {
      matchResults: { none: { score: { gte: 0, lte: 100 } } },
      initialAiMatchJobs: {
        none: {
          matchType: "INITIAL",
          state: { in: ["PENDING", "RUNNING"] },
        },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: { id: true },
  });

  if (options.dryRun) {
    return { selected: jobs.length, scheduled: 0, skipped: 0, dryRun: true };
  }

  let scheduled = 0;
  let skipped = 0;
  for (const job of jobs) {
    const result = await scheduleInitialAiMatch(job.id);
    if (result.scheduled) scheduled += 1;
    else skipped += 1;
  }
  return { selected: jobs.length, scheduled, skipped, dryRun: false };
}
