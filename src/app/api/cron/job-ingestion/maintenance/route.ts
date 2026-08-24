import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import {
  LaneBudget,
  acquireLane,
  boundedEnv,
  isAuthorizedCronRequest,
  laneOutcome,
  releaseLane,
  runLaneStep,
  unauthorizedCronResponse,
} from "@/lib/cron/lane";
import { isSchedulerPaused } from "@/lib/sync/schedulerState";
import { runCompanyDiscoverySweep } from "@/lib/sync/companyDiscovery";
import { runMassTechnicalFeedDiscovery } from "@/lib/sync/massTechnicalFeeds";
import { runFreshnessVerificationBatch } from "@/lib/sync/freshness";
import { pruneTerminalLiveDiscoveryEvents } from "@/lib/sync/liveDiscoveryMaintenance";
import { reconcileDirectOfficialFeed } from "@/lib/jobs/activeFeed";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * LANE C — maintenance.
 *
 * Everything expensive and slow-moving: the deep sweep across the whole
 * employer registry (including the Custom/API employers that need a generic
 * careers-page scan), the broad technical feeds, deep reverification, and the
 * cleanup that keeps the catalogue honest.
 *
 * This is the lane that could never run every five minutes, and separating it
 * out is what allows the other two to. It runs a few times a day.
 */

const LANE = "maintenance";
const BUDGET_MS = boundedEnv("CRON_MAINTENANCE_BUDGET_MS", 260_000, 30_000, 285_000);
const LEASE_TTL_MS = BUDGET_MS + 120_000;
const ACTIVE_TARGET = 500;

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return run();
}

export async function POST(request: Request) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return run();
}

async function run() {
  const startedAt = Date.now();

  if (await isSchedulerPaused()) {
    return NextResponse.json(
      { ok: true, lane: LANE, skipped: "scheduler_paused" },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const lease = await acquireLane(LANE, LEASE_TTL_MS);
  if (!lease.acquired) {
    return NextResponse.json(
      { ok: true, lane: LANE, skipped: "already_running", heldUntil: lease.expiresAt },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const log = await prisma.syncLog.create({ data: { source: "employer-ats", status: "running" } });
  const budget = new LaneBudget(BUDGET_MS);

  try {
    const cutover = await runLaneStep(budget, 10_000, () => reconcileDirectOfficialFeed());

    // The whole registry, oldest-checked first — including every Custom/API
    // employer that the tiered lanes deliberately skip.
    const sweep = await runLaneStep(budget, 40_000, () =>
      runCompanyDiscoverySweep({
        limit: boundedEnv("CRON_COMPANY_SWEEP_LIMIT", 1000, 1, 1000),
        concurrency: boundedEnv("CRON_COMPANY_SWEEP_CONCURRENCY", 10, 1, 20),
        maxRuntimeMs: Math.min(150_000, Math.max(30_000, budget.remainingMs() - 60_000)),
      }),
    );

    const massTechnical = await runLaneStep(budget, 20_000, () =>
      runMassTechnicalFeedDiscovery(boundedEnv("CRON_MASS_TECHNICAL_LIMIT", 1500, 1, 2000)),
    );

    const freshness = await runLaneStep(budget, 15_000, () =>
      runFreshnessVerificationBatch(boundedEnv("CRON_MAINTENANCE_VERIFY_LIMIT", 50, 1, 50)),
    );

    const pruned = await runLaneStep(budget, 5_000, () => pruneTerminalLiveDiscoveryEvents());

    const results = sweep.value?.results ?? [];
    const newJobs = results.reduce((total, result) => total + result.newCount, 0) + (massTechnical.value?.newCount ?? 0);
    const updatedJobs =
      results.reduce((total, result) => total + result.updatedCount, 0) + (massTechnical.value?.updatedCount ?? 0);
    const errors = results.filter((result) => result.status === "error").length;
    const activeAfterRun = await prisma.job.count({ where: { activeFeed: true } });

    const steps = {
      feedReconciliation: summarize(cutover),
      registrySweep: summarize(sweep),
      massTechnicalFeeds: summarize(massTechnical),
      deepFreshnessVerification: summarize(freshness),
      cleanup: summarize(pruned),
    };
    const outcome = laneOutcome(steps);

    await prisma.syncLog.update({
      where: { id: log.id },
      data: {
        status: !outcome.ok || (errors > 0 && errors === results.length) ? "error" : "success",
        ...(outcome.ok
          ? {}
          : { errorMessage: `Lane steps failed: ${outcome.failedSteps.join(", ")}`.slice(0, 500) }),
        finishedAt: new Date(),
        newJobsCount: newJobs,
        updatedJobsCount: updatedJobs,
      },
    });

    return NextResponse.json(
      {
        ok: outcome.ok,
        failedSteps: outcome.failedSteps,
        lane: LANE,
        durationMs: Date.now() - startedAt,
        budgetMs: BUDGET_MS,
        activeTarget: ACTIVE_TARGET,
        activeAfterRun,
        targetReached: activeAfterRun >= ACTIVE_TARGET,
        newJobs,
        updatedJobs,
        errors,
        unsupported: results.filter((result) => result.status === "unsupported").length,
        cutover: cutover.value ?? null,
        sweep: sweep.value
          ? {
              checked: sweep.value.checked,
              totalEligible: sweep.value.totalEligible,
              stoppedForTimeBudget: sweep.value.stoppedForTimeBudget,
              remaining: Math.max(0, sweep.value.totalEligible - sweep.value.checked),
            }
          : null,
        massTechnical: massTechnical.value ?? null,
        freshness: freshness.value ?? null,
        prunedLiveDiscoveryEvents: pruned.value ?? 0,
        steps,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    await prisma.syncLog
      .update({
        where: { id: log.id },
        data: {
          status: "error",
          finishedAt: new Date(),
          errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        },
      })
      .catch(() => undefined);
    return NextResponse.json(
      { ok: false, lane: LANE, error: "Maintenance ingestion failed.", durationMs: Date.now() - startedAt },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  } finally {
    await releaseLane(LANE, lease.holder).catch(() => undefined);
  }
}

function summarize(step: { ran: boolean; skipped?: string; ms: number; error?: string }) {
  return { ran: step.ran, skipped: step.skipped ?? null, ms: step.ms, error: step.error ?? null };
}
