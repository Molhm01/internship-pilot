import { runDiscoverySync } from "@/lib/sync/discover";
import { runQueueBatch } from "@/lib/sync/queue";
import { runCompanyDiscoveryBatch } from "@/lib/sync/companyDiscovery";
import { runNearbyFirmSearch } from "@/lib/sync/nearbyDiscovery";
import { isSchedulerPaused, recordTickResult, scheduleNextTick } from "@/lib/sync/schedulerState";
import { syncAllConnectedGmailInboxes } from "@/lib/gmail/sync";
import { isGmailConfigured } from "@/lib/gmail/oauth";
import { syncApprovedEmployersFromCsv } from "@/lib/employers/sync";
import { prepareAutomaticScoringQueues } from "@/lib/matching/automaticScoring";
import { hydrateMissingDescriptionsForScoring } from "@/lib/matching/jobDescriptionHydration";
import { requeueStaleFailedScores } from "@/lib/matching/recoverFailedScores";
import { triggerInitialAiMatchWorker } from "@/lib/matching/initialAiMatchQueue";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// Poll cadences. Individual Company rows carry their OWN nextCheckAt (5 min /
// 15-30 min staggered / daily) — companyDiscovery's 5-minute poll just checks
// "is anything due yet", it doesn't mean every company is hit every 5 minutes.
//
// Local development now uses PostgreSQL rather than SQLite, so there is no
// reason to defer the first discovery pass for an hour to avoid a file-level
// write lock. We run one bounded bootstrap pass on server startup, then continue
// on the normal cadence below.
const SCHEDULES = {
  internList: { label: "Intern List sync", intervalMs: 30 * MINUTE },
  csvSync: { label: "CSV allowlist sync", intervalMs: 30 * MINUTE },
  queue: { label: "Verification queue", intervalMs: 2 * MINUTE },
  companyDiscovery: { label: "Company Watchlist poll", intervalMs: 5 * MINUTE },
  scoring: { label: "ATS scoring maintenance", intervalMs: 2 * MINUTE },
  nearbyWeekly: { label: "Nearby-firm discovery", intervalMs: WEEK },
  gmail: { label: "Gmail application tracking", intervalMs: 5 * MINUTE },
} as const;

declare global {
  var __internshipPilotSchedulerStarted: boolean | undefined;
  var __internshipPilotScoringMaintenanceRunning: boolean | undefined;
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

// Runs entirely inside the Next.js server process — there is no separate local
// cron/worker. Started once from instrumentation.ts when the local server boots.
// All durable scheduling state lives in Postgres, so a restart resumes from the
// database instead of starting a second copy of the same work.
export function startScheduler() {
  if (globalThis.__internshipPilotSchedulerStarted) return;
  globalThis.__internshipPilotSchedulerStarted = true;

  log("starting persistent scheduler (all state is durable in Postgres)");

  // Resume durable ATS work immediately, then check again every 30 seconds.
  // The maintenance sweep below CREATES any missing work; this drain loop keeps
  // consuming it continuously without waiting for the next two-minute sweep.
  triggerInitialAiMatchWorker();
  setInterval(() => triggerInitialAiMatchWorker(), 30 * 1000);

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
            descriptions: { considered: 0, attempted: 0, hydrated: 0, failed: 0, skippedCooldown: 0 },
            recovered: { considered: 0, requeued: 0 },
            queues: { users: 0, initialQueued: 0, refreshQueued: 0 },
          };
        }

        globalThis.__internshipPilotScoringMaintenanceRunning = true;
        try {
          // 1) Jobs that arrived from a radar with only title/location cannot be
          // honestly ATS-scored yet. Pull the real employer/ATS description.
          const descriptions = await hydrateMissingDescriptionsForScoring({
            maxItems: 24,
            concurrency: 4,
          });

          // 2) A transient model/network failure must not permanently strand an
          // otherwise valid active job.
          const recovered = await requeueStaleFailedScores({ maxItems: 20 });

          // 3) Catch EVERY active job for EVERY user with an approved resume
          // profile. This is the local equivalent of the hosted cron backstop.
          const queues = await prepareAutomaticScoringQueues();

          // 4) Start the local model drain immediately instead of waiting for
          // the 30-second heartbeat above.
          triggerInitialAiMatchWorker();

          return { skipped: false as const, descriptions, recovered, queues };
        } finally {
          globalThis.__internshipPilotScoringMaintenanceRunning = false;
        }
      },
      (r) => ({
        summary: r.skipped
          ? "already running"
          : `descriptions=${r.descriptions.hydrated}/${r.descriptions.attempted}, queued=${r.queues.initialQueued + r.queues.refreshQueued}, recovered=${r.recovered.requeued}, users=${r.queues.users}`,
        errors: r.skipped ? 0 : r.descriptions.failed,
      }),
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

  setInterval(runInternList, SCHEDULES.internList.intervalMs);
  setInterval(runCsvSync, SCHEDULES.csvSync.intervalMs);
  setInterval(runVerificationQueue, SCHEDULES.queue.intervalMs);
  setInterval(runCompanyDiscovery, SCHEDULES.companyDiscovery.intervalMs);
  setInterval(runScoringMaintenance, SCHEDULES.scoring.intervalMs);
  setInterval(runNearby, SCHEDULES.nearbyWeekly.intervalMs);
  setInterval(runGmail, SCHEDULES.gmail.intervalMs);

  // Local Postgres can safely handle a bounded bootstrap pass while the server
  // is up. This makes a fresh local database useful immediately: sync the
  // allowlist if present, ingest the current Intern List radar, inspect due
  // company boards, verify what was just discovered, then hydrate + queue ATS
  // scoring for the ENTIRE active catalogue before the user has to click anything.
  void (async () => {
    await runCsvSync();
    await runInternList();
    await runCompanyDiscovery();
    await runVerificationQueue();
    await runScoringMaintenance();
    if (isGmailConfigured()) await runGmail();
  })();

  // Register next-run metadata for every schedule so the health panel has useful
  // timestamps even before the first interval fires. These writes are tiny and
  // independent of the actual bootstrap work above.
  void (async () => {
    for (const name of Object.keys(SCHEDULES) as (keyof typeof SCHEDULES)[]) {
      await scheduleNextTick(name, SCHEDULES[name].label, SCHEDULES[name].intervalMs);
    }
  })();
}
