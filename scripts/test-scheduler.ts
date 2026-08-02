import "dotenv/config";
import { prisma } from "@/lib/db";
import { nextCheckTimeFor } from "@/lib/sync/companyDiscovery";
import { scanCareersPageForInternshipLinks } from "@/lib/ats/generic";
import { isSchedulerPaused, setSchedulerPaused } from "@/lib/sync/schedulerState";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

async function main() {
  console.log("1) Cadence: priority=5min, standard=15-30min staggered, low=daily");
  const priorityNext = nextCheckTimeFor("priority", 0).getTime() - Date.now();
  check(Math.abs(priorityNext - 5 * 60 * 1000) < 2000, `priority cadence is ~5 minutes (got ${Math.round(priorityNext / 1000)}s)`);
  const standardNext = (nextCheckTimeFor("standard", 0).getTime() - Date.now()) / 60000;
  check(standardNext >= 15 && standardNext <= 30, `standard cadence falls within 15-30 min (got ${standardNext.toFixed(1)} min)`);
  const lowNext = (nextCheckTimeFor("low", 0).getTime() - Date.now()) / 60000;
  check(Math.abs(lowNext - 24 * 60) < 1, `low-priority cadence is ~daily (got ${lowNext.toFixed(1)} min)`);

  console.log("\n2) Exponential backoff on repeated failures, capped at 24h");
  const base = 5;
  const after1 = (nextCheckTimeFor("priority", 1).getTime() - Date.now()) / 60000;
  const after2 = (nextCheckTimeFor("priority", 2).getTime() - Date.now()) / 60000;
  const after10 = (nextCheckTimeFor("priority", 10).getTime() - Date.now()) / 60000;
  check(Math.abs(after1 - base * 2) < 1, `1 failure doubles the interval (got ${after1.toFixed(1)} min, expected ~${base * 2})`);
  check(Math.abs(after2 - base * 4) < 1, `2 failures quadruple the interval (got ${after2.toFixed(1)} min, expected ~${base * 4})`);
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
  await setSchedulerPaused(true);
  check((await isSchedulerPaused()) === true, "scheduler reports paused after setSchedulerPaused(true)");
  const pauseRes = await fetch(`${BASE_URL}/api/scheduler/pause`, { method: "POST" });
  const pauseData = await pauseRes.json();
  check(pauseData.paused === true, "POST /api/scheduler/pause returns paused: true");
  const statusRes = await fetch(`${BASE_URL}/api/scheduler/status`);
  const statusData = await statusRes.json();
  check(statusData.paused === true, "GET /api/scheduler/status reflects paused: true");

  const resumeRes = await fetch(`${BASE_URL}/api/scheduler/resume`, { method: "POST" });
  const resumeData = await resumeRes.json();
  check(resumeData.paused === false, "POST /api/scheduler/resume returns paused: false");
  check((await isSchedulerPaused()) === false, "scheduler reports not paused after resuming");

  console.log("\n5) Scheduler health panel data shape");
  const healthRes = await fetch(`${BASE_URL}/api/scheduler/status`);
  const health = await healthRes.json();
  const tickNames = Object.keys(health.ticks ?? {});
  check(
    ["internList", "csvSync", "queue", "companyDiscovery", "nearbyWeekly", "gmail"].every((n) => tickNames.includes(n)),
    `all 6 schedules are tracked (got: ${tickNames.join(", ")})`,
  );
  for (const name of tickNames) {
    const tick = health.ticks[name];
    check(typeof tick.nextRunAt === "string", `${name} has a next scheduled run time`);
  }

  console.log(failures === 0 ? "\nAll scheduler tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Scheduler test crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
