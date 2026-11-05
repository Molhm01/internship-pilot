import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import {
  LaneBudget,
  acquireLane,
  boundedEnv,
  cronInvocationOrigin,
  cronLaneSource,
  isAuthorizedCronRequest,
  laneOutcome,
  releaseLane,
  runLaneStep,
  unauthorizedCronResponse,
} from "@/lib/cron/lane";
import { isSchedulerPaused } from "@/lib/sync/schedulerState";
import { runTieredDuePoll } from "@/lib/sync/companyDiscovery";
import { runExpandedPublicDirectFeedDiscovery } from "@/lib/sync/publicDirectFeedsExpanded";
import { runInternListOriginalSourceDiscovery } from "@/lib/sync/discoveryResolution";
import { runFreshnessVerificationBatch } from "@/lib/sync/freshness";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * LANE B — standard.
 *
 * The ordinary polling cycle: Tier-B structured boards that have come due, the
 * public direct-employer feeds, Intern List's broader pages, and a real
 * (rather than token) freshness verification batch.
 *
 * It is slower than the fresh lane and cheaper than maintenance, which is why
 * it is separate from both: putting this work in the fresh lane would make a
 * five-minute cadence impossible, and putting it in maintenance would leave
 * ordinary employers unpolled for a day at a time.
 *
 * No Ollama, no ATS scoring, no browser. Scoring is queued by the ingest path.
 */

const LANE = "standard";
const BUDGET_MS = boundedEnv("CRON_STANDARD_BUDGET_MS", 240_000, 30_000, 280_000);
const LEASE_TTL_MS = BUDGET_MS + 60_000;

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return run(request);
}

export async function POST(request: Request) {
  if (!isAuthorizedCronRequest(request)) return unauthorizedCronResponse();
  return run(request);
}

async function run(request: Request) {
  const startedAt = Date.now();
  // Lane + invocation origin are part of the durable record so a scheduled
  // Vercel fire is provable without relying on timestamps alone.
  const invocation = cronInvocationOrigin(request);
  const runSource = cronLaneSource(LANE, invocation.origin);

  if (await isSchedulerPaused()) {
    await prisma.syncLog
      .create({
        data: { source: runSource, status: "success", finishedAt: new Date(), errorMessage: "skipped:scheduler_paused" },
      })
      .catch(() => undefined);
    return NextResponse.json(
      { ok: true, lane: LANE, skipped: "scheduler_paused" },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const lease = await acquireLane(LANE, LEASE_TTL_MS);
  if (!lease.acquired) {
    await prisma.syncLog
      .create({
        data: { source: runSource, status: "success", finishedAt: new Date(), errorMessage: "skipped:already_running" },
      })
      .catch(() => undefined);
    return NextResponse.json(
      { ok: true, lane: LANE, skipped: "already_running", heldUntil: lease.expiresAt },
      { headers: { "cache-control": "no-store" } },
    );
  }

  // Durable per-run record: created at invocation, closed at completion or
  // error, so scheduled execution is provable from the database alone.
  const log = await prisma.syncLog.create({ data: { source: runSource, status: "running" } });

  const budget = new LaneBudget(BUDGET_MS);
  try {
    const tierB = await runLaneStep(budget, 20_000, () =>
      runTieredDuePoll({
        tiers: ["B"],
        limit: boundedEnv("CRON_STANDARD_TIER_B_LIMIT", 120, 1, 400),
        concurrency: boundedEnv("CRON_STANDARD_CONCURRENCY", 8, 1, 20),
        maxRuntimeMs: Math.min(90_000, Math.max(10_000, budget.remainingMs() - 60_000)),
      }),
    );

    const publicDirect = await runLaneStep(budget, 20_000, () =>
      runExpandedPublicDirectFeedDiscovery(boundedEnv("CRON_STANDARD_PUBLIC_DIRECT_LIMIT", 300, 1, 600)),
    );

    const internList = await runLaneStep(budget, 20_000, () =>
      runInternListOriginalSourceDiscovery(boundedEnv("CRON_STANDARD_DISCOVERY_LIMIT", 25, 1, 50)),
    );

    const freshness = await runLaneStep(budget, 10_000, () =>
      runFreshnessVerificationBatch(boundedEnv("CRON_STANDARD_VERIFY_LIMIT", 30, 1, 50)),
    );

    const newJobs =
      sum(tierB.value?.results, "newCount") +
      (publicDirect.value?.newCount ?? 0) +
      (internList.value?.newCount ?? 0);
    const updatedJobs =
      sum(tierB.value?.results, "updatedCount") +
      (publicDirect.value?.updatedCount ?? 0) +
      (internList.value?.updatedCount ?? 0);

    const steps = {
      tierBPoll: summarize(tierB),
      publicDirectFeeds: summarize(publicDirect),
      internListResolution: summarize(internList),
      freshnessVerification: summarize(freshness),
    };
    const outcome = laneOutcome(steps);

    await prisma.syncLog
      .update({
        where: { id: log.id },
        data: {
          status: outcome.ok ? "success" : "error",
          ...(outcome.ok
            ? {}
            : { errorMessage: `Lane steps failed: ${outcome.failedSteps.join(", ")}`.slice(0, 500) }),
          finishedAt: new Date(),
          newJobsCount: newJobs,
          updatedJobsCount: updatedJobs,
        },
      })
      .catch(() => undefined);

    return NextResponse.json(
      {
        ok: outcome.ok,
        failedSteps: outcome.failedSteps,
        lane: LANE,
        origin: invocation.origin,
        cronSchedule: invocation.schedule,
        durationMs: Date.now() - startedAt,
        budgetMs: BUDGET_MS,
        newJobs,
        updatedJobs,
        steps,
        tierB: tierB.value
          ? {
              checked: tierB.value.checked,
              totalDue: tierB.value.totalEligible,
              stoppedForTimeBudget: tierB.value.stoppedForTimeBudget,
              errors: tierB.value.results.filter((result) => result.status === "error").length,
            }
          : null,
        freshness: freshness.value ?? null,
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
      { ok: false, lane: LANE, error: "Standard ingestion failed.", durationMs: Date.now() - startedAt },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  } finally {
    await releaseLane(LANE, lease.holder).catch(() => undefined);
  }
}

function sum(
  results: { newCount: number; updatedCount: number }[] | undefined | null,
  field: "newCount" | "updatedCount",
): number {
  return (results ?? []).reduce((total, result) => total + result[field], 0);
}

function summarize(step: { ran: boolean; skipped?: string; ms: number; error?: string }) {
  return { ran: step.ran, skipped: step.skipped ?? null, ms: step.ms, error: step.error ?? null };
}
