import { prisma } from "@/lib/db";
import { fetchEngineeringInternships } from "@/lib/sync/internListAdapter";
import { ingestJobs } from "@/lib/sync/ingest";

const SOURCE = "intern-list";

export type DiscoverySummary = {
  status: "success" | "error";
  newJobsCount: number;
  updatedJobsCount: number;
  method?: "http" | "playwright";
  errorMessage?: string;
};

export async function runDiscoverySync(): Promise<DiscoverySummary> {
  const log = await prisma.syncLog.create({
    data: { source: SOURCE, status: "running" },
  });

  try {
    const { jobs, method, capturedAt } = await fetchEngineeringInternships();
    // The SyncLog row IS this run's identity, so a job can always be traced to
    // the sync that placed it at its source row position.
    const { newCount, updatedCount } = await ingestJobs(jobs, {
      syncRunId: log.id,
      capturedAt,
    });

    await prisma.syncLog.update({
      where: { id: log.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        newJobsCount: newCount,
        updatedJobsCount: updatedCount,
      },
    });

    return { status: "success", newJobsCount: newCount, updatedJobsCount: updatedCount, method };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: "error", finishedAt: new Date(), errorMessage: message },
    });
    return { status: "error", newJobsCount: 0, updatedJobsCount: 0, errorMessage: message };
  }
}
