import { runDiscoverySync } from "@/lib/sync/discover";
import { runQueueBatch } from "@/lib/sync/queue";
import { runCompanyDiscoveryBatch } from "@/lib/sync/companyDiscovery";
import { runNearbyFirmSearch } from "@/lib/sync/nearbyDiscovery";
import { isSchedulerPaused, recordTickResult, scheduleNextTick } from "@/lib/sync/schedulerState";
import { syncGmailInbox } from "@/lib/gmail/sync";
import { isGmailConfigured } from "@/lib/gmail/oauth";
import { syncApprovedEmployersFromCsv } from "@/lib/employers/sync";
import { triggerInitialAiMatchWorker } from "@/lib/matching/initialAiMatchQueue";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// Poll cadences. Individual Company rows carry their OWN nextCheckAt (5 min /
// 15-30 min staggered / daily, per Milestone 4) — companyDiscovery's 5-minute
// poll just checks "is anything due yet", it doesn't mean every company is
// hit every 5 minutes.
// Strict discovery boundary: internships may only be discovered from the
// approved_engineering_employers.csv allowlist (via companyDiscovery) and
// Intern List (via internList). USAJOBS was removed from the scheduler for
// this reason — the code path still exists (src/lib/ats/usajobs.ts) but is
// never called automatically any more.
const SCHEDULES = {
  internList: { label: "Intern List sync", intervalMs: HOUR },
  csvSync: { label: "CSV allowlist sync", intervalMs: 30 * MINUTE },
  queue: { label: "Verification queue", intervalMs: 2 * MINUTE },
  companyDiscovery: { label: "Company Watchlist poll", intervalMs: 5 * MINUTE },
  nearbyWeekly: { label: "Nearby-firm discovery", intervalMs: WEEK },
  gmail: { label: "Gmail application tracking", intervalMs: 5 * MINUTE },
} as const;

declare global {
  var __internshipPilotSchedulerStarted: boolean | undefined;
}

function log(message: string) {
  console.log(`[scheduler] ${new Date().toISOString()} ${message}`);
}

async function runIfNotPaused<T>(name: keyof typeof SCHEDULES, task: () => Promise<T>, summarize: (r: T) => { summary: string; newJobs?: number; errors?: number }) {
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

// Runs entirely inside the Next.js server process — there is no separate
// cron/worker. Started once from instrumentation.ts when the server boots, and
// only on a local install: see the note there on why a serverless runtime does
// not get these timers. All scheduling state (Company.nextCheckAt, Job rows,
// AppSetting ticks) lives in the database, so a restart just resumes from where
// the database says things are due — nothing is lost, and nothing gets
// double-processed.
export function startScheduler() {
  if (globalThis.__internshipPilotSchedulerStarted) return;
  globalThis.__internshipPilotSchedulerStarted = true;

  log("starting persistent scheduler (survives restarts — all state is in the database)");

  // Resume only durable INITIAL work created at new-job ingestion. The worker
  // rechecks for an existing valid MatchResult before calling the model, so
  // startup never scans or automatically rescores the existing job table.
  triggerInitialAiMatchWorker();
  setInterval(() => triggerInitialAiMatchWorker(), 30 * 1000);

  const run = () =>
    runIfNotPaused(
      "internList",
      () => runDiscoverySync(),
      (r) => ({ summary: `${r.status}, new=${r.newJobsCount}, updated=${r.updatedJobsCount}`, newJobs: r.newJobsCount, errors: r.status === "error" ? 1 : 0 }),
    );
  // Startup only registers the scheduler. Discovery begins on its cadence so
  // it cannot monopolize SQLite while the application worker acquires and
  // recovers its queue during a service restart.
  setInterval(run, SCHEDULES.internList.intervalMs);

  const runCsvSync = () =>
    runIfNotPaused(
      "csvSync",
      () => syncApprovedEmployersFromCsv(),
      (r) =>
        r.ran
          ? { summary: `${r.totalRows} row(s): ${r.created} created, ${r.updated} updated, ${r.deallowlisted} de-allowlisted` }
          : { summary: "skipped (data/approved_engineering_employers.csv not found yet)" },
    );
  setInterval(runCsvSync, SCHEDULES.csvSync.intervalMs);

  setInterval(
    () =>
      runIfNotPaused(
        "queue",
        () => runQueueBatch(),
        (s) => ({
          summary: `verified=${s.verified} needsReview=${s.needsReview} closed=${s.closed} quarantined=${s.quarantined} scored=${s.scored} errors=${s.errors}`,
          errors: s.errors,
        }),
      ),
    SCHEDULES.queue.intervalMs,
  );

  setInterval(
    () =>
      runIfNotPaused(
        "companyDiscovery",
        () => runCompanyDiscoveryBatch(8),
        (r) => ({
          summary: `checked=${r.checked}`,
          newJobs: r.results.reduce((sum, c) => sum + c.newCount, 0),
          errors: r.results.filter((c) => c.status === "error").length,
        }),
      ),
    SCHEDULES.companyDiscovery.intervalMs,
  );

  setInterval(
    () =>
      runIfNotPaused(
        "nearbyWeekly",
        () => runNearbyFirmSearch(),
        (r) => ({ summary: r.configured ? `discovered=${r.discovered}, promoted=${r.promoted}` : "skipped (GOOGLE_PLACES_API_KEY not configured)" }),
      ),
    SCHEDULES.nearbyWeekly.intervalMs,
  );

  setInterval(
    () =>
      runIfNotPaused(
        "gmail",
        () => syncGmailInbox(),
        (r) =>
          r.skipped === "not_connected"
            ? { summary: "skipped (Gmail not connected)" }
            : { summary: `checked=${r.checked} classified=${r.classified} newAssessments=${r.newAssessments} errors=${r.errors}`, errors: r.errors },
      ),
    SCHEDULES.gmail.intervalMs,
  );
  if (isGmailConfigured()) {
    runIfNotPaused(
      "gmail",
      () => syncGmailInbox(),
      (r) =>
        r.skipped === "not_connected"
          ? { summary: "skipped (Gmail not connected)" }
          : { summary: `checked=${r.checked} classified=${r.classified} newAssessments=${r.newAssessments} errors=${r.errors}`, errors: r.errors },
    );
  }

  // Register "next run" for schedules whose first real tick is far away, so
  // the health panel shows something sensible immediately on boot. Awaited
  // sequentially — each schedule now has its own row (see schedulerState.ts)
  // so this isn't strictly required for correctness any more, but there's no
  // reason to open five concurrent writes at startup either.
  void (async () => {
    for (const name of Object.keys(SCHEDULES) as (keyof typeof SCHEDULES)[]) {
      await scheduleNextTick(name, SCHEDULES[name].label, SCHEDULES[name].intervalMs);
    }
  })();
}
