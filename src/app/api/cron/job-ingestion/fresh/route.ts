import { NextResponse } from "next/server";

import {
  LaneBudget,
  boundedEnv,
  isAuthorizedCronRequest,
  laneOutcome,
  runLaneStep,
  unauthorizedCronResponse,
} from "@/lib/cron/lane";
import { checkPausedAndDue, markRan, notDueStep } from "@/lib/cron/dueGate";
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
 *
 * No DB-backed lease (database-usage repair, pass #4): GitHub Actions is the
 * sole scheduler owner, and .github/workflows/live-job-ingestion.yml declares
 * `concurrency: { group: ingestion-lane-fresh, cancel-in-progress: false }`
 * on this lane's job — the same group for both its scheduled and
 * workflow_dispatch triggers — so GitHub Actions itself already refuses to
 * run two overlapping invocations of this lane. The DB lease this route used
 * to acquire/release existed to protect against Vercel's OWN cron
 * double-firing a five-minute schedule; that trigger path was removed
 * entirely in pass #1 (see vercel.json). What remains — a direct curl bypass
 * of GitHub Actions with a stolen CRON_SECRET — is low-probability, and every
 * operation on this path is an idempotent upsert, so the worst case of a
 * genuine race is wasted duplicate work, not corrupted state. Removing the
 * lease saves 2 Prisma operations (an acquire + a release) on every single
 * tick, 144 times a day, to guard against a risk GitHub Actions already
 * mostly covers. Maintenance (src/app/api/cron/job-ingestion/maintenance)
 * keeps its lease: it runs once a day, so the same 2 operations cost nothing
 * relative to its frequency, and a maintenance overlap is more disruptive
 * (long-running, catalog-wide) than a fresh-lane one.
 */

const LANE = "fresh";
// Hard budget, well under both the function timeout and the target cadence, so
// a slow employer board can never make this lane overlap its own next run.
const BUDGET_MS = boundedEnv("CRON_FRESH_BUDGET_MS", 110_000, 20_000, 240_000);

// Freshness verification gets its own cadence, independent of the lane's own
// 10-minute trigger (pass #4, item 5) — the per-job re-verification floors
// added in pass #2 already rate-limit how often any ONE job can be
// re-checked, so gating the whole step to run on roughly every other tick
// costs nothing in real detection latency while halving its ticks.
const FRESHNESS_GATE_NAME = "fresh:freshnessVerification";
const FRESHNESS_INTERVAL_MS = boundedEnv("CRON_FRESH_VERIFY_INTERVAL_MS", 20 * 60 * 1000, 5 * 60 * 1000, 6 * 60 * 60 * 1000);

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

  // One query covers scheduler-pause state AND whether freshness
  // verification is due — a tick that turns out to be paused costs exactly
  // this one operation.
  const gate = await checkPausedAndDue([{ name: FRESHNESS_GATE_NAME, intervalMs: FRESHNESS_INTERVAL_MS }]);
  if (gate.paused) {
    return NextResponse.json(
      { ok: true, lane: LANE, skipped: "scheduler_paused" },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const budget = new LaneBudget(BUDGET_MS);
  // 1. Fresh radar signals -> canonical official postings. This is the step
  //    that both attaches new signals to jobs already in the catalogue and
  //    priority-crawls a known employer's official board to find the real
  //    posting behind an aggregator signal.
  //    It gets a sub-budget rather than the whole invocation: measured cold,
  //    it took 89 of 110 seconds and left the employer poll with six of forty
  //    due boards and no time for verification. Signals it does not reach are
  //    already queued and are picked up by the next tick, so stopping early
  //    costs nothing but a few minutes of latency on the tail. When there are
  //    no fresh signals at all (the common case on a 10-minute cadence) this
  //    step is zero Prisma operations — see the empty-work fast path in
  //    runJobrightFreshDiscovery.
  const radarShare = Math.round(BUDGET_MS * 0.55);
  const radar = await runLaneStep(budget, 15_000, () =>
    runJobrightFreshDiscovery(boundedEnv("CRON_FRESH_SIGNAL_LIMIT", 120, 10, 400), radarShare),
  );

  // 2. Tier-A structured ATS employers whose backoff has elapsed. Bounded by
  //    whatever budget the radar left, never by a fixed wall-clock guess.
  //    This due-fetch is one unavoidable query every tick: cost scales with
  //    companies actually due, and "how many are due" can only be answered
  //    by asking (a 0-row answer still costs the one query that proves it).
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
  //    Gated to its own ~20-minute cadence (see FRESHNESS_INTERVAL_MS) — a
  //    tick where it isn't due costs 0 additional operations.
  const freshness = gate.due[FRESHNESS_GATE_NAME]
    ? await runLaneStep(budget, 8_000, async () => {
        const result = await runFreshnessVerificationBatch(boundedEnv("CRON_FRESH_VERIFY_LIMIT", 8, 1, 30));
        await markRan(FRESHNESS_GATE_NAME);
        return result;
      })
    : notDueStep<Awaited<ReturnType<typeof runFreshnessVerificationBatch>>>();

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
