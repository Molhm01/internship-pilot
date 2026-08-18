/*
 * Shared data, but not public data.
 *
 * Browser self-healing and manual recovery ingest the largest current direct
 * technical-internship feeds first, then use Intern List as a secondary signal,
 * sweep the owned employer registry, and re-check older active jobs.
 */
import { guardSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runQueueBatch } from "@/lib/sync/queue";
import { runCompanyDiscoverySweep, runUsaJobsDiscovery } from "@/lib/sync/companyDiscovery";
import { runInternListOriginalSourceDiscovery } from "@/lib/sync/discoveryResolution";
import { runFreshnessVerificationBatch } from "@/lib/sync/freshness";
import { runExpandedPublicDirectFeedDiscovery } from "@/lib/sync/publicDirectFeedsExpanded";
import { runMassTechnicalFeedDiscovery } from "@/lib/sync/massTechnicalFeeds";
import { reconcileDirectOfficialFeed } from "@/lib/jobs/activeFeed";

export const runtime = "nodejs";
export const maxDuration = 300;

const RECENT_RUNNING_WINDOW_MS = 7 * 60 * 1000;
const ACTIVE_TARGET = 500;

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

    const massTechnical = await runMassTechnicalFeedDiscovery(1500);
    const publicDirect = await runExpandedPublicDirectFeedDiscovery(600);
    const discovery = await runInternListOriginalSourceDiscovery(50);

    const companies = await runCompanyDiscoverySweep({
      limit: 1000,
      concurrency: 10,
      maxRuntimeMs: 75_000,
    });

    const freshness = await runFreshnessVerificationBatch(50);
    const usajobs = await runUsaJobsDiscovery();
    const queue = await runQueueBatch();

    const newJobsCount =
      companies.results.reduce((sum, company) => sum + company.newCount, 0) +
      massTechnical.newCount +
      publicDirect.newCount +
      discovery.newCount +
      usajobs.newCount;
    const updatedJobsCount =
      companies.results.reduce((sum, company) => sum + company.updatedCount, 0) +
      massTechnical.updatedCount +
      publicDirect.updatedCount +
      discovery.updatedCount +
      usajobs.updatedCount;
    const companyErrors = companies.results.filter((company) => company.status === "error").length;
    const activeAfterRun = await prisma.job.count({ where: { activeFeed: true } });

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
      activeTarget: ACTIVE_TARGET,
      activeAfterRun,
      targetReached: activeAfterRun >= ACTIVE_TARGET,
      cutover,
      massTechnical,
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
