import { runDiscoverySync } from "@/lib/sync/discover";
import { runQueueBatch } from "@/lib/sync/queue";
import { runCompanyDiscoveryBatch } from "@/lib/sync/companyDiscovery";
import { runNearbyFirmSearch } from "@/lib/sync/nearbyDiscovery";
import {
  isSchedulerPaused,
  ensureDiscoveryQualityCohortStarted,
  recordSchedulerHeartbeat,
  recordTickResult,
  scheduleNextTick,
} from "@/lib/sync/schedulerState";
import { syncAllConnectedGmailInboxes } from "@/lib/gmail/sync";
import { isGmailConfigured } from "@/lib/gmail/oauth";
import { syncApprovedEmployersFromCsv } from "@/lib/employers/sync";
import { prepareAutomaticScoringQueues } from "@/lib/matching/automaticScoring";
import { hydrateMissingDescriptionsForScoring } from "@/lib/matching/jobDescriptionHydration";
import { requeueStaleFailedScores } from "@/lib/matching/recoverFailedScores";
import { triggerInitialAiMatchWorker } from "@/lib/matching/initialAiMatchQueue";
import {
  formatFreshRadarDiagnostics,
  runJobrightFreshDiscovery,
} from "@/lib/sync/jobrightFreshDiscovery";
import { runMassTechnicalFeedDiscovery } from "@/lib/sync/massTechnicalFeeds";
import { runExpandedPublicDirectFeedDiscovery } from "@/lib/sync/publicDirectFeedsExpanded";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// Local development has a long-lived Node process, so it can run the same
// discovery layers that otherwise sit behind hosted cron/manual routes.
//
// Fresh radar is intentionally frequent: Jobright is a DISCOVERY SIGNAL only;
// a job becomes an active listing only after the code resolves it to an original
// employer/ATS destination. Broad feeds already expose job-specific official
// URLs and keep catalogue depth high without depending on one aggregator.
const SCHEDULES = {
  // Five minutes is the freshness target: a posting that appeared "20 minutes
  // ago" on a public feed should already be in Discover. Repeat ticks are cheap
  // because resolved signals are skipped and unresolved ones honour a backoff.
  freshRadar: { label: "Fresh engineering radar", intervalMs: 5 * MINUTE },
  broadRadar: { label: "Broad technical radar", intervalMs: 30 * MINUTE },
  internList: { label: "Intern List sync", intervalMs: 30 * MINUTE },
  csvSync: { label: "CSV allowlist sync", intervalMs: 30 * MINUTE },
  queue: { label: "Verification queue", intervalMs: 2 * MINUTE },
  companyDiscovery: { label: "Company Watchlist poll", intervalMs: 5 * MINUTE },
  qualityHydration: { label: "Official job quality hydration", intervalMs: 2 * MINUTE },
  scoring: { label: "ATS scoring maintenance", intervalMs: 2 * MINUTE },
  nearbyWeekly: { label: "Nearby-firm discovery", intervalMs: WEEK },
  gmail: { label: "Gmail application tracking", intervalMs: 5 * MINUTE },
} as const;

declare global {
  var __internshipPilotSchedulerStarted: boolean | undefined;
  var __internshipPilotScoringMaintenanceRunning: boolean | undefined;
  var __internshipPilotQualityHydrationRunning: boolean | undefined;
  var __internshipPilotBroadRadarRunning: boolean | undefined;
}

function log(message: string) {
  console.log(`[scheduler] ${new Date().toISOString()} ${message}`);
}

async function runIfNotPaused<T>(
  name: keyof typeof SCHEDULES,
  task: () => Promise<T>,
  summarize: (r: T) => { summary: string; newJobs?: number; errors?: number },
) {
  const { label, intervalMs } = SCHEDULES[name];
  await scheduleNextTick(name, label, intervalMs);

  if (await isSchedulerPaused()) {
    log(`${label}: skipped (monitoring paused)`);
    return;
  }

  try {
    const result = await task();
    const { summary, newJobs, errors } = summarize(result);
    await recordTickResult(name, { status: "success", summary, newJobs, errors });
    log(`${label}: ${summary}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordTickResult(name, { status: "error", summary: message, errors: 1 });
    log(`${label} failed: ${message}`);
  }
}

// Runs in its own Node process — scripts/scheduler-worker.ts, supervised by
// `npm run local` alongside the website and the application worker. The Next.js
// server does NOT start it: importing this module from src/instrumentation.ts
// pulled @/lib/db -> @prisma/adapter-pg -> pg -> pgpass into Next's bundle, and
// Windows Webpack then failed to resolve the Node built-ins `fs` and `path`.
// All durable scheduling state lives in Postgres, so a restart resumes from the
// database instead of starting a second copy of the same work.
export function startScheduler(options: { scoringEnabled?: boolean } = {}) {
  if (globalThis.__internshipPilotSchedulerStarted) return;
  globalThis.__internshipPilotSchedulerStarted = true;
  const scoringEnabled = options.scoringEnabled !== false;

  log("starting persistent scheduler (all state is durable in Postgres)");

  const schedulerStartedAt = new Date().toISOString();
  void ensureDiscoveryQualityCohortStarted(new Date(schedulerStartedAt)).catch((error) =>
    log(`quality cohort instrumentation failed: ${error instanceof Error ? error.message : String(error)}`),
  );
  void recordSchedulerHeartbeat(schedulerStartedAt).catch((error) =>
    log(`health heartbeat failed: ${error instanceof Error ? error.message : String(error)}`),
  );
  setInterval(() => {
    void recordSchedulerHeartbeat(schedulerStartedAt).catch((error) =>
      log(`health heartbeat failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  }, 15_000);

  // Resume durable ATS work immediately, then check again every 30 seconds.
  // The maintenance sweep below CREATES any missing work; this drain loop keeps
  // consuming it continuously without waiting for the next two-minute sweep.
  if (scoringEnabled) {
    triggerInitialAiMatchWorker();
    setInterval(() => triggerInitialAiMatchWorker(), 30 * 1000);
  }

  const runFreshRadar = () =>
    runIfNotPaused(
      "freshRadar",
      () => runJobrightFreshDiscovery(),
      (r) => ({
        summary: formatFreshRadarDiagnostics(r),
        newJobs: r.newJobs,
      }),
    );

  const runBroadRadar = () =>
    runIfNotPaused(
      "broadRadar",
      async () => {
        // Avoid starting a second high-throughput public-feed pass when one run
        // takes longer than the cadence. The following tick will catch up.
        if (globalThis.__internshipPilotBroadRadarRunning) {
          return {
            skipped: true as const,
            mass: null,
            direct: null,
          };
        }

        globalThis.__internshipPilotBroadRadarRunning = true;
        try {
          const mass = await runMassTechnicalFeedDiscovery(1500);
          const direct = await runExpandedPublicDirectFeedDiscovery(600);
          return { skipped: false as const, mass, direct };
        } finally {
          globalThis.__internshipPilotBroadRadarRunning = false;
        }
      },
      (r) => {
        if (r.skipped || !r.mass || !r.direct) return { summary: "already running" };
        const newJobs = r.mass.newCount + r.direct.newCount;
        const updatedJobs = r.mass.updatedCount + r.direct.updatedCount;
        return {
          summary:
            `source=${r.mass.sourceFetched + r.direct.sourceFetched}, examined=${r.mass.examined + r.direct.examined}, ` +
            `new=${newJobs}, updated=${updatedJobs}, alreadyActive=${r.mass.alreadyActive + r.direct.alreadyActive}`,
          newJobs,
        };
      },
    );

  const runInternList = () =>
    runIfNotPaused(
      "internList",
      () => runDiscoverySync(),
      (r) => ({
        summary: `${r.status}, new=${r.newJobsCount}, updated=${r.updatedJobsCount}`,
        newJobs: r.newJobsCount,
        errors: r.status === "error" ? 1 : 0,
      }),
    );

  const runCsvSync = () =>
    runIfNotPaused(
      "csvSync",
      () => syncApprovedEmployersFromCsv(),
      (r) =>
        r.ran
          ? {
              summary: `${r.totalRows} row(s): ${r.created} created, ${r.updated} updated, ${r.deallowlisted} de-allowlisted`,
            }
          : { summary: "skipped (data/approved_engineering_employers.csv not found yet)" },
    );

  const runVerificationQueue = () =>
    runIfNotPaused(
      "queue",
      () => runQueueBatch(),
      (s) => ({
        summary: `verified=${s.verified} needsReview=${s.needsReview} closed=${s.closed} quarantined=${s.quarantined} scored=${s.scored} errors=${s.errors}`,
        errors: s.errors,
      }),
    );

  const runCompanyDiscovery = () =>
    runIfNotPaused(
      "companyDiscovery",
      () => runCompanyDiscoveryBatch(8),
      (r) => ({
        summary: `checked=${r.checked}`,
        newJobs: r.results.reduce((sum, c) => sum + c.newCount, 0),
        errors: r.results.filter((c) => c.status === "error").length,
      }),
    );

  const runScoringMaintenance = () =>
    runIfNotPaused(
      "scoring",
      async () => {
        // Never overlap a network-heavy description hydration pass with itself.
        // The next interval simply catches anything still outstanding.
        if (globalThis.__internshipPilotScoringMaintenanceRunning) {
          return {
            skipped: true as const,
            recovered: { considered: 0, requeued: 0 },
            queues: { users: 0, initialQueued: 0, refreshQueued: 0 },
          };
        }

        globalThis.__internshipPilotScoringMaintenanceRunning = true;
        try {
          // 1) A transient model/network failure must not permanently strand an
          // otherwise valid active job.
          const recovered = await requeueStaleFailedScores({ maxItems: 20 });

          // 2) Catch EVERY active job for EVERY user with an approved resume
          // profile. This is the local equivalent of the hosted cron backstop.
          const queues = await prepareAutomaticScoringQueues();

          // 3) Start the local model drain immediately instead of waiting for
          // the 30-second heartbeat above.
          triggerInitialAiMatchWorker();

          return { skipped: false as const, recovered, queues };
        } finally {
          globalThis.__internshipPilotScoringMaintenanceRunning = false;
        }
      },
      (r) => ({
        summary: r.skipped
          ? "already running"
          : `queued=${r.queues.initialQueued + r.queues.refreshQueued}, recovered=${r.recovered.requeued}, users=${r.queues.users}`,
        errors: 0,
      }),
    );

  const runQualityHydration = () =>
    runIfNotPaused(
      "qualityHydration",
      async () => {
        if (globalThis.__internshipPilotQualityHydrationRunning) return null;
        globalThis.__internshipPilotQualityHydrationRunning = true;
        try {
          return await hydrateMissingDescriptionsForScoring({ maxItems: 24, concurrency: 3 });
        } finally {
          globalThis.__internshipPilotQualityHydrationRunning = false;
        }
      },
      (result) => result
        ? {
            summary: `descriptions=${result.hydrated}/${result.attempted}, dates=${result.datesHydrated}, failed=${result.failed}`,
            errors: result.failed,
          }
        : { summary: "already running" },
    );

  const runNearby = () =>
    runIfNotPaused(
      "nearbyWeekly",
      () => runNearbyFirmSearch(),
      (r) => ({
        summary: r.configured
          ? `discovered=${r.discovered}, promoted=${r.promoted}`
          : "skipped (GOOGLE_PLACES_API_KEY not configured)",
      }),
    );

  const runGmail = () =>
    runIfNotPaused(
      "gmail",
      () => syncAllConnectedGmailInboxes(),
      (r) =>
        r.skipped === "not_connected"
          ? { summary: "skipped (Gmail not connected)" }
          : {
              summary: `checked=${r.checked} classified=${r.classified} newAssessments=${r.newAssessments} errors=${r.errors}`,
              errors: r.errors,
            },
    );

  setInterval(runFreshRadar, SCHEDULES.freshRadar.intervalMs);
  setInterval(runBroadRadar, SCHEDULES.broadRadar.intervalMs);
  setInterval(runInternList, SCHEDULES.internList.intervalMs);
  setInterval(runCsvSync, SCHEDULES.csvSync.intervalMs);
  setInterval(runVerificationQueue, SCHEDULES.queue.intervalMs);
  setInterval(runCompanyDiscovery, SCHEDULES.companyDiscovery.intervalMs);
  setInterval(runQualityHydration, SCHEDULES.qualityHydration.intervalMs);
  if (scoringEnabled) setInterval(runScoringMaintenance, SCHEDULES.scoring.intervalMs);
  setInterval(runNearby, SCHEDULES.nearbyWeekly.intervalMs);
  setInterval(runGmail, SCHEDULES.gmail.intervalMs);

  // A fresh local database should become useful during the SAME work session.
  // Sync the employer allowlist first, then run the fresh radar, broad official
  // feeds, the legacy Intern List surface, employer boards and verification.
  // ATS hydration/scoring runs last so newly ingested jobs immediately enter the
  // resume-match pipeline without requiring a button click.
  void (async () => {
    await runCsvSync();
    await runFreshRadar();
    await runBroadRadar();
    await runInternList();
    await runCompanyDiscovery();
    await runVerificationQueue();
    await runQualityHydration();
    if (scoringEnabled) await runScoringMaintenance();
    if (isGmailConfigured()) await runGmail();
  })();

  // Register next-run metadata for every schedule so the health panel has useful
  // timestamps even before the first interval fires. These writes are tiny and
  // independent of the actual bootstrap work above.
  void (async () => {
    for (const name of Object.keys(SCHEDULES) as (keyof typeof SCHEDULES)[]) {
      if (name === "scoring" && !scoringEnabled) continue;
      await scheduleNextTick(name, SCHEDULES[name].label, SCHEDULES[name].intervalMs);
    }
  })();
}
