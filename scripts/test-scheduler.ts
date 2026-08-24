import "dotenv/config";
import { pinCanonicalDatabaseUrl, announceCanonicalDatabase } from "./lib/canonicalDb";

const canonical = pinCanonicalDatabaseUrl();

import { prisma } from "@/lib/db";
import { nextCheckTimeFor } from "@/lib/sync/companyDiscovery";
import { scanCareersPageForInternshipLinks } from "@/lib/ats/generic";
import {
  getSchedulerPauseState,
  getSchedulerHealth,
  isSchedulerPaused,
  setSchedulerPaused,
  type SchedulerPauseMetadata,
} from "@/lib/sync/schedulerState";

let failures = 0;
let initialPause: { paused: boolean; metadata: SchedulerPauseMetadata | null } | null = null;
function check(condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

async function main() {
  announceCanonicalDatabase(await prisma.job.count(), canonical);
  initialPause = await getSchedulerPauseState();
  console.log("1) Cadence: priority=5min, standard=15-30min staggered, low=daily");
  const priorityNext = (nextCheckTimeFor("priority", 0, "workday").getTime() - Date.now()) / 60000;
  check(priorityNext >= 5 && priorityNext <= 10, `priority structured-provider cadence is 5-10 minutes (got ${priorityNext.toFixed(1)} min)`);
  const standardNext = (nextCheckTimeFor("standard", 0, "workday").getTime() - Date.now()) / 60000;
  check(standardNext >= 20 && standardNext <= 30, `standard structured-provider cadence falls within 20-30 min (got ${standardNext.toFixed(1)} min)`);
  const lowNext = (nextCheckTimeFor("low", 0).getTime() - Date.now()) / 60000;
  check(Math.abs(lowNext - 24 * 60) < 1, `low-priority cadence is ~daily (got ${lowNext.toFixed(1)} min)`);

  console.log("\n2) Exponential backoff on repeated failures, capped at 24h");
  const after1 = (nextCheckTimeFor("priority", 1, "workday").getTime() - Date.now()) / 60000;
  const after2 = (nextCheckTimeFor("priority", 2, "workday").getTime() - Date.now()) / 60000;
  const after10 = (nextCheckTimeFor("priority", 10, "workday").getTime() - Date.now()) / 60000;
  check(after1 >= 10 && after1 <= 20, `1 failure doubles the jittered 5-10 minute interval (got ${after1.toFixed(1)} min)`);
  check(after2 >= 20 && after2 <= 40, `2 failures quadruple the jittered 5-10 minute interval (got ${after2.toFixed(1)} min)`);
  check(Math.abs(after10 - 24 * 60) < 1, `backoff is capped at 24h even after many failures (got ${after10.toFixed(1)} min)`);

  console.log("\n3) Conditional requests: a 304 response is treated as 'nothing new' without re-parsing");
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ etag: '"abc123"' }),
        text: async () => '<a href="/jobs/1">Electrical Intern</a>',
      } as unknown as Response;
    }
    return { ok: false, status: 304, headers: new Headers({ etag: '"abc123"' }), text: async () => "" } as unknown as Response;
  }) as typeof fetch;

  try {
    const first = await scanCareersPageForInternshipLinks("https://example-conditional.test/careers", "Test Co");
    check(first.jobs.length === 1 && first.etag === '"abc123"', "first fetch parses the page and captures an ETag");

    const second = await scanCareersPageForInternshipLinks("https://example-conditional.test/careers", "Test Co", {
      etag: first.etag,
    });
    check(second.notModified === true, "second fetch with the stored ETag gets a 304 and is marked notModified");
    check(second.jobs.length === 0, "no jobs re-parsed on a 304 (nothing wasted)");
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("\n4) Pause / Resume Monitoring");
  await setSchedulerPaused(true, {
    source: "test-scheduler",
    reason: "bounded_pause_resume_test",
    // A killed test process still cannot strand this temporary pause forever.
    expiresAt: new Date(Date.now() + 2 * 60 * 1000),
  });
  check((await isSchedulerPaused()) === true, "scheduler reports paused after setSchedulerPaused(true)");
  const pausedHealth = await getSchedulerHealth();
  check(pausedHealth.paused === true, "durable scheduler health reflects paused: true");
  check(pausedHealth.pause?.source === "test-scheduler", "pause ownership is observable");

  await setSchedulerPaused(false, { source: "test-scheduler", reason: "bounded_pause_resume_test_complete" });
  check((await isSchedulerPaused()) === false, "scheduler reports not paused after resuming");

  console.log("\n5) Scheduler health panel data shape");
  const health = await getSchedulerHealth();
  const tickNames = Object.keys(health.ticks ?? {});
  check(
    ["internList", "csvSync", "queue", "companyDiscovery", "nearbyWeekly", "gmail"].every((n) => tickNames.includes(n)),
    `all 6 schedules are tracked (got: ${tickNames.join(", ")})`,
  );
  for (const name of tickNames) {
    const tick = health.ticks[name];
    check(typeof tick.nextRunAt === "string", `${name} has a next scheduled run time`);
  }
  check(health.worker?.healthy === true, "persistent scheduler worker heartbeat is healthy");

  console.log(failures === 0 ? "\nAll scheduler tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Scheduler test crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (initialPause) {
      const metadata = initialPause.metadata;
      await setSchedulerPaused(initialPause.paused, {
        source: metadata?.source ?? "test-scheduler",
        reason: metadata?.reason ?? "restore_pre_test_scheduler_state",
        expiresAt: metadata?.expiresAt ? new Date(metadata.expiresAt) : null,
      }).catch((error) => {
        console.error("Could not restore the pre-test scheduler pause state:", error);
        process.exitCode = 1;
      });
    }
    await prisma.$disconnect();
  });
