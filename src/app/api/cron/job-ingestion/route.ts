import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runCompanyDiscoverySweep } from "@/lib/sync/companyDiscovery";
import { runInternListOriginalSourceDiscovery } from "@/lib/sync/discoveryResolution";
import { runFreshnessVerificationBatch } from "@/lib/sync/freshness";
import { runExpandedPublicDirectFeedDiscovery } from "@/lib/sync/publicDirectFeedsExpanded";
import { runMassTechnicalFeedDiscovery } from "@/lib/sync/massTechnicalFeeds";
import { runJobrightFreshDiscovery } from "@/lib/sync/jobrightFreshDiscovery";
import { isSchedulerPaused } from "@/lib/sync/schedulerState";
import { reconcileDirectOfficialFeed } from "@/lib/jobs/activeFeed";

export const runtime = "nodejs";
export const maxDuration = 300;

const RECENT_RUNNING_WINDOW_MS = 7 * 60 * 1000;
const ACTIVE_TARGET = 500;

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
    // Do not cap fresh ingestion at a token number: the whole point of the fresh
    // radar is that every legitimate recent posting gets a resolution attempt.
    const freshDiscoveryLimit = Math.min(
      1000,
      Math.max(1, Number.parseInt(process.env.CRON_FRESH_DISCOVERY_LIMIT ?? "400", 10) || 400),
    );
    const discoveryLimit = Math.min(
      50,
      Math.max(1, Number.parseInt(process.env.CRON_DISCOVERY_RESOLVE_LIMIT ?? "50", 10) || 50),
    );
    const publicDirectLimit = Math.min(
      600,
      Math.max(1, Number.parseInt(process.env.CRON_PUBLIC_DIRECT_LIMIT ?? "600", 10) || 600),
    );
    const massTechnicalLimit = Math.min(
      2000,
      Math.max(1, Number.parseInt(process.env.CRON_MASS_TECHNICAL_LIMIT ?? "1500", 10) || 1500),
    );
    const freshnessLimit = Math.min(
      50,
      Math.max(1, Number.parseInt(process.env.CRON_FRESHNESS_CHECK_LIMIT ?? "50", 10) || 50),
    );

    // FRESHNESS FIRST. Jobright's public internship minisites carry exact
    // source timestamps, so resolve the newest technical rows before spending
    // time on historical catalogue depth. This is the lane that competes on
    // "posted minutes/hours ago", not merely on total active count.
    const freshDiscovery = await runJobrightFreshDiscovery(freshDiscoveryLimit);

    // Maintain the 500+ catalogue target after the fresh lane has had first use
    // of the invocation budget.
    const massTechnical = await runMassTechnicalFeedDiscovery(massTechnicalLimit);
    const publicDirect = await runExpandedPublicDirectFeedDiscovery(publicDirectLimit);

    // Intern List's broader public pages remain useful for depth and employers
    // missing from the exact-timestamp minisites.
    const discovery = await runInternListOriginalSourceDiscovery(discoveryLimit);

    // Direct employer registry remains the owned-source backbone, but receives a
    // bounded tail of the run so fresh discovery cannot be starved by the sweep.
    const result = await runCompanyDiscoverySweep({
      limit: sweepLimit,
      concurrency: sweepConcurrency,
      maxRuntimeMs: 65_000,
    });
    const freshness = await runFreshnessVerificationBatch(freshnessLimit);

    const companyNewJobs = result.results.reduce((sum, company) => sum + company.newCount, 0);
    const companyUpdatedJobs = result.results.reduce((sum, company) => sum + company.updatedCount, 0);
    const newJobs =
      companyNewJobs +
      freshDiscovery.newJobs +
      massTechnical.newCount +
      publicDirect.newCount +
      discovery.newCount;
    const updatedJobs =
      companyUpdatedJobs +
      freshDiscovery.updatedJobs +
      massTechnical.updatedCount +
      publicDirect.updatedCount +
      discovery.updatedCount;
    const errors = result.results.filter((company) => company.status === "error").length;
    const unsupported = result.results.filter((company) => company.status === "unsupported").length;
    const activeAfterRun = await prisma.job.count({ where: { activeFeed: true } });

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
        activeTarget: ACTIVE_TARGET,
        activeAfterRun,
        targetReached: activeAfterRun >= ACTIVE_TARGET,
        cutover,
        checked: result.checked,
        totalEligible: result.totalEligible,
        stoppedForTimeBudget: result.stoppedForTimeBudget,
        remainingInSweep: Math.max(0, result.totalEligible - result.checked),
        newJobs,
        updatedJobs,
        errors,
        unsupported,
        freshDiscovery,
        massTechnical,
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
