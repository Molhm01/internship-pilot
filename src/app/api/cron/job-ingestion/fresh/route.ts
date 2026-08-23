import { NextResponse } from "next/server";

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
import { runJobrightFreshDiscovery } from "@/lib/sync/jobrightFreshDiscovery";
import { runTieredDuePoll } from "@/lib/sync/companyDiscovery";
import { runFreshnessVerificationBatch } from "@/lib/sync/freshness";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * LANE A — fresh.
 *
 * The only lane that is allowed to run every few minutes, and therefore the
 * only one whose contents are chosen for latency rather than coverage. It
 * does exactly three things: read the fresh radar and resolve those signals to
 * real employer postings, poll the Tier-A structured boards whose backoff has
 * elapsed, and spot-check that a handful of recent postings are still open.
 *
 * What it deliberately does NOT do, because none of it can finish inside a
 * five-minute cadence and none of it is what "new job, now" needs:
 *   - the whole-registry employer sweep (maintenance)
 *   - custom/API employer scans and headless resolution (maintenance)
 *   - description refresh and deep reverification (standard/maintenance)
 *   - any Ollama call or ATS scoring (scoring is queued, never executed here)
 *
 * A newly discovered official job is written straight into the active feed by
 * the ingest path. It does not wait for a score, a tailored résumé, or any AI
 * processing to become visible in Discover.
 */

const LANE = "fresh";
// Hard budget, well under both the function timeout and the target cadence, so
// a slow employer board can never make this lane overlap its own next run.
const BUDGET_MS = boundedEnv("CRON_FRESH_BUDGET_MS", 110_000, 20_000, 240_000);
const LEASE_TTL_MS = BUDGET_MS + 60_000;

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
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }

  const budget = new LaneBudget(BUDGET_MS);
  try {
    // 1. Fresh radar signals -> canonical official postings. This is the step
    //    that both attaches new signals to jobs already in the catalogue and
    //    priority-crawls a known employer's official board to find the real
    //    posting behind an aggregator signal.
    //    It gets a sub-budget rather than the whole invocation: measured cold,
    //    it took 89 of 110 seconds and left the employer poll with six of forty
    //    due boards and no time for verification. Signals it does not reach are
    //    already queued and are picked up by the next tick, so stopping early
    //    costs nothing but a few minutes of latency on the tail.
    const radarShare = Math.round(BUDGET_MS * 0.55);
    const radar = await runLaneStep(budget, 15_000, () =>
      runJobrightFreshDiscovery(boundedEnv("CRON_FRESH_SIGNAL_LIMIT", 120, 10, 400), radarShare),
    );

    // 2. Tier-A structured ATS employers whose backoff has elapsed. Bounded by
    //    whatever budget the radar left, never by a fixed wall-clock guess.
    const tierA = await runLaneStep(budget, 10_000, () =>
      runTieredDuePoll({
        tiers: ["A"],
        limit: boundedEnv("CRON_FRESH_TIER_A_LIMIT", 40, 1, 200),
        concurrency: boundedEnv("CRON_FRESH_CONCURRENCY", 6, 1, 12),
        // The poll can only check its budget between concurrent waves, so it
        // overshoots by up to one wave. Both a hard ceiling and a reserve for
        // the verification step below account for that: a first measured run
        // that reserved only 15s still starved verification completely.
        maxRuntimeMs: Math.min(40_000, Math.max(5_000, budget.remainingMs() - 25_000)),
      }),
    );

    // 3. Minimal freshness verification: enough to stop a closed posting from
    //    sitting at the top of Discover, not a catalogue-wide reverification.
    const freshness = await runLaneStep(budget, 8_000, () =>
      runFreshnessVerificationBatch(boundedEnv("CRON_FRESH_VERIFY_LIMIT", 8, 1, 30)),
    );

    const newJobs = (radar.value?.newJobs ?? 0) + sumNew(tierA.value?.results);
    const updatedJobs = (radar.value?.updatedJobs ?? 0) + sumUpdated(tierA.value?.results);
    const steps = {
      freshRadar: summarize(radar),
      tierAPoll: summarize(tierA),
      freshnessVerification: summarize(freshness),
    };
    const outcome = laneOutcome(steps);

    return NextResponse.json(
      {
        ok: outcome.ok,
        failedSteps: outcome.failedSteps,
        lane: LANE,
        durationMs: Date.now() - startedAt,
        budgetMs: BUDGET_MS,
        newJobs,
        updatedJobs,
        steps,
        radar: radar.value
          ? {
              signalsFetched: radar.value.signalsFetched,
              under24h: radar.value.under24h,
              under72h: radar.value.under72h,
              examined: radar.value.examined,
              alreadyFoundOfficial: radar.value.alreadyFoundOfficial,
              boardResolved: radar.value.boardResolved,
              unresolved: radar.value.unresolved,
              newJobs: radar.value.newJobs,
              stoppedForTimeBudget: radar.value.stoppedForTimeBudget,
            }
          : null,
        tierA: tierA.value
          ? {
              checked: tierA.value.checked,
              totalDue: tierA.value.totalEligible,
              stoppedForTimeBudget: tierA.value.stoppedForTimeBudget,
              errors: tierA.value.results.filter((result) => result.status === "error").length,
            }
          : null,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } finally {
    await releaseLane(LANE, lease.holder).catch(() => undefined);
  }
}

function sumNew(results: { newCount: number }[] | undefined | null): number {
  return (results ?? []).reduce((total, result) => total + result.newCount, 0);
}

function sumUpdated(results: { updatedCount: number }[] | undefined | null): number {
  return (results ?? []).reduce((total, result) => total + result.updatedCount, 0);
}

/** Step telemetry only — never the step's own payload, which may be large. */
function summarize(step: { ran: boolean; skipped?: string; ms: number; error?: string }) {
  return { ran: step.ran, skipped: step.skipped ?? null, ms: step.ms, error: step.error ?? null };
}
