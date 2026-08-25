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
import { checkDue, markRan, notDueStep } from "@/lib/cron/dueGate";
import { isSchedulerPaused } from "@/lib/sync/schedulerState";
import { runTieredDuePoll } from "@/lib/sync/companyDiscovery";
import { runExpandedPublicDirectFeedDiscovery } from "@/lib/sync/publicDirectFeedsExpanded";
import { runInternListOriginalSourceDiscovery } from "@/lib/sync/discoveryResolution";
import { runFreshnessVerificationBatch } from "@/lib/sync/freshness";
import { hydrateMissingDescriptionsForScoring } from "@/lib/matching/jobDescriptionHydration";

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
 *
 * Per-source due-gating (database-usage repair, pass #2): three of the five
 * steps below — the public-direct-feed scan, the Intern List scan, and
 * description hydration — used to run on EVERY hourly tick regardless of
 * whether that source had anything new. Each now has its own cadence,
 * independent of the lane's own hourly cadence, tracked in one shared
 * AppSetting-backed cursor (src/lib/cron/dueGate.ts). Tier-B polling is left
 * ungated here because it is already due-gated per company at the query
 * level (selectDueByTier/runTieredDuePoll only ever reads companies whose own
 * nextCheckAt has elapsed — a tick with nothing due costs exactly one query
 * that returns zero rows, not a skip worth adding a second layer of gating
 * to). Freshness verification is also left running every tick, but is now
 * itself bounded by a minimum per-job re-verification floor that scales with
 * posting age (see runFreshnessVerificationBatch) so it stops repeatedly
 * re-checking the same small pool of already-fresh jobs.
 */

const LANE = "standard";
const BUDGET_MS = boundedEnv("CRON_STANDARD_BUDGET_MS", 240_000, 30_000, 280_000);
const LEASE_TTL_MS = BUDGET_MS + 60_000;

// Own cadence per source. Sized so each still runs several times a day at
// the lane's hourly cadence, while a lane tick where none of them are due
// costs one shared "due" query instead of three full step executions.
const PUBLIC_DIRECT_INTERVAL_MS = boundedEnv(
  "CRON_STANDARD_PUBLIC_DIRECT_INTERVAL_MS",
  3 * 60 * 60 * 1000, // 3h — ApplyGuy/Dreamwork are static JSON indexes that do not change hourly.
  30 * 60 * 1000,
  24 * 60 * 60 * 1000,
);
const INTERN_LIST_INTERVAL_MS = boundedEnv(
  "CRON_STANDARD_INTERN_LIST_INTERVAL_MS",
  2 * 60 * 60 * 1000, // 2h
  30 * 60 * 1000,
  24 * 60 * 60 * 1000,
);
const QUALITY_HYDRATION_INTERVAL_MS = boundedEnv(
  "CRON_STANDARD_HYDRATION_INTERVAL_MS",
  2 * 60 * 60 * 1000, // 2h — hydration is a quality/scoring input, not discovery-blocking.
  15 * 60 * 1000,
  24 * 60 * 60 * 1000,
);

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

    // One shared query decides whether the public-direct-feed scan, the
    // Intern List scan, and description hydration are due at all this tick —
    // the common case on an hourly cadence with multi-hour per-source
    // intervals is that none of them are, and this is the only cost paid.
    const due = await checkDue([
      { name: "standard:publicDirectFeeds", intervalMs: PUBLIC_DIRECT_INTERVAL_MS },
      { name: "standard:internList", intervalMs: INTERN_LIST_INTERVAL_MS },
      { name: "standard:qualityHydration", intervalMs: QUALITY_HYDRATION_INTERVAL_MS },
    ]);

    const publicDirect = due["standard:publicDirectFeeds"]
      ? await runLaneStep(budget, 20_000, async () => {
          const result = await runExpandedPublicDirectFeedDiscovery(
            boundedEnv("CRON_STANDARD_PUBLIC_DIRECT_LIMIT", 300, 1, 600),
          );
          await markRan("standard:publicDirectFeeds");
          return result;
        })
      : notDueStep<Awaited<ReturnType<typeof runExpandedPublicDirectFeedDiscovery>>>();

    const internList = due["standard:internList"]
      ? await runLaneStep(budget, 20_000, async () => {
          const result = await runInternListOriginalSourceDiscovery(
            boundedEnv("CRON_STANDARD_DISCOVERY_LIMIT", 25, 1, 50),
          );
          await markRan("standard:internList");
          return result;
        })
      : notDueStep<Awaited<ReturnType<typeof runInternListOriginalSourceDiscovery>>>();

    const freshness = await runLaneStep(budget, 10_000, () =>
      runFreshnessVerificationBatch(boundedEnv("CRON_STANDARD_VERIFY_LIMIT", 30, 1, 50)),
    );

    // Quality hydration is public HTTP only and deliberately independent of
    // the model-scoring cron. A deployment with no model key still recovers
    // official dates and descriptions.
    const qualityHydration = due["standard:qualityHydration"]
      ? await runLaneStep(budget, 15_000, async () => {
          const result = await hydrateMissingDescriptionsForScoring({
            maxItems: boundedEnv("CRON_STANDARD_HYDRATION_LIMIT", 12, 1, 30),
            concurrency: 4,
          });
          await markRan("standard:qualityHydration");
          return result;
        })
      : notDueStep<Awaited<ReturnType<typeof hydrateMissingDescriptionsForScoring>>>();

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
      qualityHydration: summarize(qualityHydration),
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
        tierB: tierB.value
          ? {
              checked: tierB.value.checked,
              totalDue: tierB.value.totalEligible,
              stoppedForTimeBudget: tierB.value.stoppedForTimeBudget,
              errors: tierB.value.results.filter((result) => result.status === "error").length,
            }
          : null,
        freshness: freshness.value ?? null,
        qualityHydration: qualityHydration.value ?? null,
      },
      { headers: { "cache-control": "no-store" } },
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
