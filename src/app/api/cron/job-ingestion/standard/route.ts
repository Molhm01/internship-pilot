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
 * Per-source due-gating (pass #2, extended in pass #4): the public-direct-
 * feed scan, the Intern List scan, description hydration, AND (new in pass
 * #4) freshness verification each have their own cadence, independent of the
 * lane's own hourly cadence, tracked in AppSetting-backed cursors. Scheduler
 * pause and all four gates are read in ONE query (checkPausedAndDue) — a
 * tick where nothing gated is due costs exactly that one operation before
 * even reaching Tier-B. Tier-B polling itself is left ungated: it is already
 * due-gated per company at the query level (runTieredDuePoll only ever reads
 * companies whose own nextCheckAt has elapsed — a tick with nothing due
 * costs exactly one query that returns zero rows).
 *
 * No DB-backed lease (pass #4): see the fresh lane's route for the full
 * reasoning — GitHub Actions' `concurrency: { group: ingestion-lane-standard
 * }` already serializes this lane's own invocations, which is what the lease
 * existed to protect against after Vercel's own cron trigger was removed in
 * pass #1.
 */

const LANE = "standard";
const BUDGET_MS = boundedEnv("CRON_STANDARD_BUDGET_MS", 240_000, 30_000, 280_000);

// Own cadence per source. Sized so each still runs several times a day at
// the lane's hourly cadence, while a lane tick where none of them are due
// costs one shared "due" query instead of four full step executions.
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
// Freshness already has a per-job re-verification floor (pass #2); gating
// the whole step to run on roughly every other standard tick (lane cadence
// is hourly) costs nothing in real detection latency.
const FRESHNESS_INTERVAL_MS = boundedEnv(
  "CRON_STANDARD_VERIFY_INTERVAL_MS",
  90 * 60 * 1000,
  30 * 60 * 1000,
  12 * 60 * 60 * 1000,
);

const PUBLIC_DIRECT_GATE = "standard:publicDirectFeeds";
const INTERN_LIST_GATE = "standard:internList";
const QUALITY_HYDRATION_GATE = "standard:qualityHydration";
const FRESHNESS_GATE = "standard:freshnessVerification";

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

  const gate = await checkPausedAndDue([
    { name: PUBLIC_DIRECT_GATE, intervalMs: PUBLIC_DIRECT_INTERVAL_MS },
    { name: INTERN_LIST_GATE, intervalMs: INTERN_LIST_INTERVAL_MS },
    { name: QUALITY_HYDRATION_GATE, intervalMs: QUALITY_HYDRATION_INTERVAL_MS },
    { name: FRESHNESS_GATE, intervalMs: FRESHNESS_INTERVAL_MS },
  ]);
  if (gate.paused) {
    return NextResponse.json(
      { ok: true, lane: LANE, skipped: "scheduler_paused" },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const budget = new LaneBudget(BUDGET_MS);
  const tierB = await runLaneStep(budget, 20_000, () =>
    runTieredDuePoll({
      tiers: ["B"],
      limit: boundedEnv("CRON_STANDARD_TIER_B_LIMIT", 120, 1, 400),
      concurrency: boundedEnv("CRON_STANDARD_CONCURRENCY", 8, 1, 20),
      maxRuntimeMs: Math.min(90_000, Math.max(10_000, budget.remainingMs() - 60_000)),
    }),
  );

  const publicDirect = gate.due[PUBLIC_DIRECT_GATE]
    ? await runLaneStep(budget, 20_000, async () => {
        const result = await runExpandedPublicDirectFeedDiscovery(
          boundedEnv("CRON_STANDARD_PUBLIC_DIRECT_LIMIT", 300, 1, 600),
        );
        await markRan(PUBLIC_DIRECT_GATE);
        return result;
      })
    : notDueStep<Awaited<ReturnType<typeof runExpandedPublicDirectFeedDiscovery>>>();

  const internList = gate.due[INTERN_LIST_GATE]
    ? await runLaneStep(budget, 20_000, async () => {
        const result = await runInternListOriginalSourceDiscovery(
          boundedEnv("CRON_STANDARD_DISCOVERY_LIMIT", 25, 1, 50),
        );
        await markRan(INTERN_LIST_GATE);
        return result;
      })
    : notDueStep<Awaited<ReturnType<typeof runInternListOriginalSourceDiscovery>>>();

  const freshness = gate.due[FRESHNESS_GATE]
    ? await runLaneStep(budget, 10_000, async () => {
        const result = await runFreshnessVerificationBatch(boundedEnv("CRON_STANDARD_VERIFY_LIMIT", 30, 1, 50));
        await markRan(FRESHNESS_GATE);
        return result;
      })
    : notDueStep<Awaited<ReturnType<typeof runFreshnessVerificationBatch>>>();

  // Quality hydration is public HTTP only and deliberately independent of
  // the model-scoring cron. A deployment with no model key still recovers
  // official dates and descriptions.
  const qualityHydration = gate.due[QUALITY_HYDRATION_GATE]
    ? await runLaneStep(budget, 15_000, async () => {
        const result = await hydrateMissingDescriptionsForScoring({
          maxItems: boundedEnv("CRON_STANDARD_HYDRATION_LIMIT", 12, 1, 30),
          concurrency: 4,
        });
        await markRan(QUALITY_HYDRATION_GATE);
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
