/*
 * Shared data, but not public data.
 *
 * Browser self-healing and manual recovery ingest broad public direct-job
 * feeds first, then use Intern List as a secondary discovery signal, sweep the
 * owned employer registry, and re-check older active jobs.
 */
import { guardSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runQueueBatch } from "@/lib/sync/queue";
import { runCompanyDiscoverySweep, runUsaJobsDiscovery } from "@/lib/sync/companyDiscovery";
import { runInternListOriginalSourceDiscovery } from "@/lib/sync/discoveryResolution";
import { runFreshnessVerificationBatch } from "@/lib/sync/freshness";
import { runExpandedPublicDirectFeedDiscovery } from "@/lib/sync/publicDirectFeedsExpanded";
import { reconcileDirectOfficialFeed } from "@/lib/jobs/activeFeed";

export const runtime = "nodejs";
export const maxDuration = 300;

const RECENT_RUNNING_WINDOW_MS = 7 * 60 * 1000;

async function recentRunningSync() {
  return prisma.syncLog.findFirst({
    where: {
      source: "employer-ats",
      status: "running",
      startedAt: { gte: new Date(Date.now() - RECENT_RUNNING_WINDOW_MS) },
    },
    select: { id: true, startedAt: true },
    orderBy: { startedAt: "desc" },
  });
}

export async function POST() {
  const denied = await guardSession();
  if (denied) return denied;

  const running = await recentRunningSync();
  if (running) {
    return NextResponse.json(
      {
        ok: true,
        skipped: "already_running",
        runningSince: running.startedAt.toISOString(),
      },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  }

  const log = await prisma.syncLog.create({ data: { source: "employer-ats", status: "running" } });
  try {
    const cutover = await reconcileDirectOfficialFeed();

    // Consume the whole current direct-feed candidate set first. A current
    // source row already contains the job-specific original employer/ATS URL,
    // so Vercel bot-block responses must not starve Discover coverage.
    const publicDirect = await runExpandedPublicDirectFeedDiscovery(600);

    // Intern List remains useful for roles not present in the direct feeds, but
    // it still must resolve back to a live original employer posting.
    const discovery = await runInternListOriginalSourceDiscovery(50);

    // Continue the direct-employer registry afterward. It is resumable and
    // oldest-first, so repeated automatic runs still cover the full catalogue.
    const companies = await runCompanyDiscoverySweep({
      limit: 1000,
      concurrency: 10,
      maxRuntimeMs: 110_000,
    });

    const freshness = await runFreshnessVerificationBatch(50);
    const usajobs = await runUsaJobsDiscovery();
    const queue = await runQueueBatch();

    const newJobsCount =
      companies.results.reduce((sum, company) => sum + company.newCount, 0) +
      publicDirect.newCount +
      discovery.newCount +
      usajobs.newCount;
    const updatedJobsCount =
      companies.results.reduce((sum, company) => sum + company.updatedCount, 0) +
      publicDirect.updatedCount +
      discovery.updatedCount +
      usajobs.updatedCount;
    const companyErrors = companies.results.filter((company) => company.status === "error").length;

    await prisma.syncLog.update({
      where: { id: log.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        newJobsCount,
        updatedJobsCount,
        ...(companyErrors > 0 ? { errorMessage: `${companyErrors} employer check(s) failed.` } : {}),
      },
    });

    return NextResponse.json({
      ok: true,
      cutover,
      publicDirect,
      discovery,
      companies,
      freshness,
      usajobs,
      queue,
      companySweepRemaining: Math.max(0, companies.totalEligible - companies.checked),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: "error", finishedAt: new Date(), errorMessage: message.slice(0, 500) },
    }).catch(() => undefined);
    return NextResponse.json({ error: "Employer sync failed." }, { status: 500 });
  }
}
