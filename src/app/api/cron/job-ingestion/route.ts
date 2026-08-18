import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runCompanyDiscoverySweep } from "@/lib/sync/companyDiscovery";
import { runInternListOriginalSourceDiscovery } from "@/lib/sync/discoveryResolution";
import { runFreshnessVerificationBatch } from "@/lib/sync/freshness";
import { runExpandedPublicDirectFeedDiscovery } from "@/lib/sync/publicDirectFeedsExpanded";
import { isSchedulerPaused } from "@/lib/sync/schedulerState";
import { reconcileDirectOfficialFeed } from "@/lib/jobs/activeFeed";

export const runtime = "nodejs";
export const maxDuration = 300;

const RECENT_RUNNING_WINDOW_MS = 7 * 60 * 1000;

function unauthorized() {
  return NextResponse.json(
    { error: "Unauthorized cron request." },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return unauthorized();

  if (await isSchedulerPaused()) {
    return NextResponse.json(
      { ok: true, skipped: "scheduler_paused", checked: 0, newJobs: 0, updatedJobs: 0, errors: 0 },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const running = await prisma.syncLog.findFirst({
    where: {
      source: "employer-ats",
      status: "running",
      startedAt: { gte: new Date(Date.now() - RECENT_RUNNING_WINDOW_MS) },
    },
    select: { id: true, startedAt: true },
    orderBy: { startedAt: "desc" },
  });
  if (running) {
    return NextResponse.json(
      {
        ok: true,
        skipped: "already_running",
        runningSince: running.startedAt.toISOString(),
        checked: 0,
        newJobs: 0,
        updatedJobs: 0,
        errors: 0,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const startedAt = Date.now();
  const log = await prisma.syncLog.create({ data: { source: "employer-ats", status: "running" } });

  try {
    const cutover = await reconcileDirectOfficialFeed();

    const sweepLimit = Math.min(
      1000,
      Math.max(1, Number.parseInt(process.env.CRON_COMPANY_SWEEP_LIMIT ?? "1000", 10) || 1000),
    );
    const sweepConcurrency = Math.min(
      20,
      Math.max(1, Number.parseInt(process.env.CRON_COMPANY_SWEEP_CONCURRENCY ?? "10", 10) || 10),
    );
    const discoveryLimit = Math.min(
      50,
      Math.max(1, Number.parseInt(process.env.CRON_DISCOVERY_RESOLVE_LIMIT ?? "50", 10) || 50),
    );
    const publicDirectLimit = Math.min(
      600,
      Math.max(1, Number.parseInt(process.env.CRON_PUBLIC_DIRECT_LIMIT ?? "600", 10) || 600),
    );
    const freshnessLimit = Math.min(
      50,
      Math.max(1, Number.parseInt(process.env.CRON_FRESHNESS_CHECK_LIMIT ?? "50", 10) || 50),
    );

    // Highest-yield first: consume the full current public direct-feed pool.
    // These feeds already carry the original job-specific employer/ATS URL, so
    // ATS bot challenges must not make legitimate listings disappear merely
    // because Vercel cannot re-fetch the same page server-side.
    const publicDirect = await runExpandedPublicDirectFeedDiscovery(publicDirectLimit);

    // Intern List remains a secondary discovery signal for roles the direct
    // feeds miss. Its candidates still resolve to an original employer post.
    const discovery = await runInternListOriginalSourceDiscovery(discoveryLimit);

    // Continue the owned-employer sweep after the broad current feeds. It is
    // resumable/oldest-first, so repeated runs still cover the full registry.
    const result = await runCompanyDiscoverySweep({
      limit: sweepLimit,
      concurrency: sweepConcurrency,
      maxRuntimeMs: 120_000,
    });
    const freshness = await runFreshnessVerificationBatch(freshnessLimit);

    const companyNewJobs = result.results.reduce((sum, company) => sum + company.newCount, 0);
    const companyUpdatedJobs = result.results.reduce((sum, company) => sum + company.updatedCount, 0);
    const newJobs = companyNewJobs + discovery.newCount + publicDirect.newCount;
    const updatedJobs = companyUpdatedJobs + discovery.updatedCount + publicDirect.updatedCount;
    const errors = result.results.filter((company) => company.status === "error").length;
    const unsupported = result.results.filter((company) => company.status === "unsupported").length;

    await prisma.syncLog.update({
      where: { id: log.id },
      data: {
        status: errors === result.checked && result.checked > 0 ? "error" : "success",
        finishedAt: new Date(),
        newJobsCount: newJobs,
        updatedJobsCount: updatedJobs,
        ...(errors === result.checked && result.checked > 0 ? { errorMessage: "All checked employers failed." } : {}),
      },
    });

    return NextResponse.json(
      {
        ok: errors === 0,
        cutover,
        checked: result.checked,
        totalEligible: result.totalEligible,
        stoppedForTimeBudget: result.stoppedForTimeBudget,
        remainingInSweep: Math.max(0, result.totalEligible - result.checked),
        newJobs,
        updatedJobs,
        errors,
        unsupported,
        publicDirect,
        discovery,
        freshness,
        durationMs: Date.now() - startedAt,
        companies: result.results.map((company) => ({
          name: company.name,
          status: company.status,
          newCount: company.newCount,
          updatedCount: company.updatedCount,
        })),
      },
      { status: errors === result.checked && result.checked > 0 ? 503 : 200, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: "error", finishedAt: new Date(), errorMessage: message.slice(0, 500) },
    }).catch(() => undefined);
    return NextResponse.json(
      { ok: false, error: "Employer ingestion failed.", durationMs: Date.now() - startedAt },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
