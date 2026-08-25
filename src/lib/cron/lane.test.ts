import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CRON_LANES,
  LaneBudget,
  boundedEnv,
  isAuthorizedCronRequest,
  laneOutcome,
  leaseIsAvailable,
  leaseKey,
  parseLease,
  runLaneStep,
} from "@/lib/cron/lane";
import {
  checkCompanySafely,
  selectDueByTier,
  type TieredPollCandidate,
} from "@/lib/sync/companyDiscovery";

function requestWith(headers: Record<string, string>): Request {
  return new Request("https://example.test/api/cron/job-ingestion/fresh", { headers });
}

describe("hosted cron authentication", () => {
  it("accepts only the exact CRON_SECRET bearer token", () => {
    process.env.CRON_SECRET = "s3cret-value";
    expect(isAuthorizedCronRequest(requestWith({ authorization: "Bearer s3cret-value" }))).toBe(true);
    expect(isAuthorizedCronRequest(requestWith({ authorization: "Bearer s3cret-valuE" }))).toBe(false);
    expect(isAuthorizedCronRequest(requestWith({ authorization: "Bearer s3cret" }))).toBe(false);
    expect(isAuthorizedCronRequest(requestWith({ authorization: "s3cret-value" }))).toBe(false);
    expect(isAuthorizedCronRequest(requestWith({}))).toBe(false);
  });

  it("refuses everything when no secret is configured, rather than defaulting open", () => {
    delete process.env.CRON_SECRET;
    expect(isAuthorizedCronRequest(requestWith({ authorization: "Bearer anything" }))).toBe(false);
    expect(isAuthorizedCronRequest(requestWith({ authorization: "Bearer " }))).toBe(false);
  });
});

describe("lane leases prevent overlapping runs", () => {
  const now = new Date("2026-08-23T12:00:00.000Z");

  it("gives every lane its own key", () => {
    const keys = CRON_LANES.map(leaseKey);
    expect(new Set(keys).size).toBe(CRON_LANES.length);
    expect(keys).toContain("cron:lease:job-ingestion:fresh");
  });

  it("treats a live lease as unavailable and an expired one as reclaimable", () => {
    const live = { holder: "a", acquiredAt: now.toISOString(), expiresAt: "2026-08-23T12:04:00.000Z" };
    const dead = { holder: "b", acquiredAt: now.toISOString(), expiresAt: "2026-08-23T11:59:00.000Z" };
    expect(leaseIsAvailable(live, now)).toBe(false);
    expect(leaseIsAvailable(dead, now)).toBe(true);
    expect(leaseIsAvailable(null, now)).toBe(true);
  });

  it("treats an unparseable or corrupt lease as reclaimable rather than deadlocking the lane", () => {
    expect(parseLease("not json")).toBeNull();
    expect(parseLease(JSON.stringify({ holder: 1 }))).toBeNull();
    expect(leaseIsAvailable(parseLease("not json"), now)).toBe(true);
    expect(
      leaseIsAvailable({ holder: "a", acquiredAt: "x", expiresAt: "not-a-date" }, now),
    ).toBe(true);
  });
});

describe("lane time budgeting", () => {
  it("stops scheduling steps once the budget is spent", async () => {
    const budget = new LaneBudget(1_000, Date.now() - 900);
    const cheap = await runLaneStep(budget, 50, async () => "ran");
    const expensive = await runLaneStep(budget, 5_000, async () => "ran");
    expect(cheap.ran).toBe(true);
    expect(expensive.ran).toBe(false);
    expect(expensive.skipped).toBe("budget_exhausted");
  });

  it("contains a step failure instead of failing the whole lane", async () => {
    const budget = new LaneBudget(60_000);
    const step = await runLaneStep(budget, 10, async () => {
      throw new Error("employer board timed out");
    });
    expect(step.ran).toBe(true);
    expect(step.value).toBeNull();
    expect(step.error).toMatch(/employer board timed out/);
  });

  it("does not report a lane as ok when a contained step failed", () => {
    // Containing a step failure keeps one bad employer board from losing the
    // whole invocation. Reporting ok anyway would make a broken registry sweep
    // indistinguishable from a clean one in the cron log — which is exactly
    // what a first measured maintenance run did.
    expect(
      laneOutcome({
        feedReconciliation: { error: null },
        registrySweep: { error: "Database error. Code: 08P01" },
        cleanup: {},
      }),
    ).toEqual({ ok: false, failedSteps: ["registrySweep"] });

    expect(laneOutcome({ a: { error: null }, b: {} })).toEqual({ ok: true, failedSteps: [] });
  });

  it("clamps env-configured limits into their safe range", () => {
    process.env.LANE_TEST_LIMIT = "99999";
    expect(boundedEnv("LANE_TEST_LIMIT", 10, 1, 50)).toBe(50);
    process.env.LANE_TEST_LIMIT = "-4";
    expect(boundedEnv("LANE_TEST_LIMIT", 10, 1, 50)).toBe(1);
    delete process.env.LANE_TEST_LIMIT;
    expect(boundedEnv("LANE_TEST_LIMIT", 10, 1, 50)).toBe(10);
    process.env.LANE_TEST_LIMIT = "not a number";
    expect(boundedEnv("LANE_TEST_LIMIT", 10, 1, 50)).toBe(10);
    delete process.env.LANE_TEST_LIMIT;
  });
});

describe("tiered due selection", () => {
  const now = new Date("2026-08-23T12:00:00.000Z");

  function company(overrides: Partial<TieredPollCandidate> & { id: string }): TieredPollCandidate {
    return {
      atsType: "greenhouse",
      careersUrl: "https://example.test/careers",
      priority: "standard",
      csvEeCpeFit: null,
      engineeringActivityTier: null,
      nextCheckAt: null,
      lastCheckedAt: null,
      ...overrides,
    };
  }

  it("returns only employers of the requested tier whose backoff has elapsed", () => {
    const candidates = [
      company({ id: "tierA-due", engineeringActivityTier: "A", nextCheckAt: new Date("2026-08-23T11:00:00.000Z") }),
      company({ id: "tierA-not-due", engineeringActivityTier: "A", nextCheckAt: new Date("2026-08-23T12:30:00.000Z") }),
      company({ id: "tierB-due", engineeringActivityTier: "B", nextCheckAt: null }),
    ];
    const selected = selectDueByTier(candidates, { tiers: ["A"], limit: 10, now });
    expect(selected.map((entry) => entry.id)).toEqual(["tierA-due"]);
  });

  it("never selects an unstructured Custom employer into a tiered lane", () => {
    const candidates = [
      company({ id: "custom", atsType: "custom", priority: "priority", engineeringActivityTier: "A" }),
      company({ id: "unknown-provider", atsType: null, priority: "priority" }),
    ];
    expect(selectDueByTier(candidates, { tiers: ["A", "B"], limit: 10, now })).toEqual([]);
    // They are exactly the tier-C population the maintenance lane owns.
    expect(selectDueByTier(candidates, { tiers: ["C"], limit: 10, now })).toHaveLength(2);
  });

  it("orders by tier, then by how overdue the employer is, and honours the limit", () => {
    const candidates = [
      company({ id: "b-old", engineeringActivityTier: "B", nextCheckAt: new Date("2026-08-23T09:00:00.000Z") }),
      company({ id: "a-recent", engineeringActivityTier: "A", nextCheckAt: new Date("2026-08-23T11:59:00.000Z") }),
      company({ id: "a-old", engineeringActivityTier: "A", nextCheckAt: new Date("2026-08-23T08:00:00.000Z") }),
    ];
    const selected = selectDueByTier(candidates, { tiers: ["A", "B"], limit: 2, now });
    expect(selected.map((entry) => entry.id)).toEqual(["a-old", "a-recent"]);
  });
});

describe("one bad employer never loses the whole sweep", () => {
  it("records a thrown employer check as an error result and keeps going", async () => {
    // A measured maintenance run lost an entire 340-employer sweep when a
    // single bookkeeping write failed with PostgreSQL 08P01 — a pooled
    // prepared-statement collision that had nothing to do with the employer
    // being checked. checkCompany catches board errors but not that one.
    const result = await checkCompanySafely({ id: "company-1", name: "Acme" }, async () => {
      throw new Error("Database error. Code: `08P01`.");
    });

    expect(result.status).toBe("error");
    expect(result.companyId).toBe("company-1");
    expect(result.name).toBe("Acme");
    expect(result.newCount).toBe(0);
    expect(result.error).toMatch(/08P01/);
  });

  it("passes a successful check straight through", async () => {
    const success = {
      companyId: "company-2",
      name: "Beta",
      status: "success" as const,
      newCount: 3,
      updatedCount: 1,
      jobsScanned: 10,
      totalAvailableJobs: 40,
      engineeringInternshipsFound: 3,
      missingCount: 0,
      closedCount: 0,
      durationMs: 120,
    };
    expect(await checkCompanySafely({ id: "company-2" }, async () => success)).toBe(success);
  });
});

describe("the lanes are actually wired up", () => {
  async function repoFile(relative: string): Promise<string> {
    return readFile(path.join(process.cwd(), relative), "utf8");
  }

  it("ships a route file for every declared lane, authenticated and pause-aware", async () => {
    for (const lane of CRON_LANES) {
      const source = await repoFile(`src/app/api/cron/job-ingestion/${lane}/route.ts`);
      expect(source, `${lane} lane must authenticate`).toContain("isAuthorizedCronRequest");
      // Every lane must honour the paused switch — fresh/standard via the
      // combined checkPausedAndDue read (pass #4), maintenance via the
      // original isSchedulerPaused (it still takes a DB lease, so a separate
      // pause query costs nothing extra relative to its once-a-day cadence).
      const honoursPause = source.includes("isSchedulerPaused") || source.includes("checkPausedAndDue");
      expect(honoursPause, `${lane} lane must honour the paused switch`).toBe(true);
    }
  });

  it("maintenance keeps a DB-backed lease; fresh/standard rely on GitHub Actions concurrency instead", async () => {
    // Database-usage repair, pass #4: fresh and standard fire every 10/60
    // minutes, so an acquire+release lease cost real, recurring operations —
    // removed once GitHub Actions' own `concurrency` groups (see
    // .github/workflows/live-job-ingestion.yml) started serializing each
    // lane's invocations, which is what the lease existed to protect against
    // after Vercel's cron trigger was removed in pass #1. Maintenance runs
    // once a day, where the same lease costs nothing worth optimizing, and
    // guards a longer-running, more disruptive-to-overlap job.
    const maintenance = await repoFile("src/app/api/cron/job-ingestion/maintenance/route.ts");
    expect(maintenance, "maintenance lane must take a lease").toContain("acquireLane");
    expect(maintenance, "maintenance lane must release its lease").toContain("releaseLane");

    for (const lane of ["fresh", "standard"] as const) {
      const source = await repoFile(`src/app/api/cron/job-ingestion/${lane}/route.ts`);
      expect(source, `${lane} lane must not take a DB-backed lease`).not.toContain("acquireLane");
      expect(source, `${lane} lane must not release a DB-backed lease`).not.toContain("releaseLane");
    }

    const workflow = await repoFile(".github/workflows/live-job-ingestion.yml");
    expect(workflow).toContain("group: ingestion-lane-fresh");
    expect(workflow).toContain("group: ingestion-lane-standard");
    expect(workflow).toContain("cancel-in-progress: false");
  });

  /** Comments explain what a lane avoids; only executable code is evidence. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  it("keeps Ollama, ATS scoring and browser automation out of every hosted lane", async () => {
    for (const lane of CRON_LANES) {
      const code = stripComments(await repoFile(`src/app/api/cron/job-ingestion/${lane}/route.ts`));
      expect(code.toLowerCase(), `${lane} lane must not touch Ollama`).not.toContain("ollama");
      expect(code.toLowerCase(), `${lane} lane must not drive a browser`).not.toContain("playwright");
      expect(code, `${lane} lane must not run ATS scoring inline`).not.toMatch(/runAiMatch|scoreJob|matchWorkflow/);
    }
  });

  it("declares no Vercel crons — GitHub Actions is the sole production scheduler", async () => {
    // A QStash */5 recurring schedule and a vercel.json daily cron used to
    // run job-ingestion/standard and job-ingestion/maintenance on top of
    // GitHub Actions already driving the same routes — two or three
    // schedulers overlapping on the same lanes, which was the largest single
    // driver of the Prisma Postgres Free-plan overage (see the DATABASE
    // USAGE DIAGNOSTIC / DATABASE EFFICIENCY REPAIR reports). There must
    // never be a second scheduler for these lanes again.
    const vercel = JSON.parse(await repoFile("vercel.json")) as {
      crons?: { path: string; schedule: string }[];
    };
    expect(vercel.crons ?? []).toHaveLength(0);
  });

  it("drives the ten-minute fresh lane from the external scheduler", async () => {
    const workflow = await repoFile(".github/workflows/live-job-ingestion.yml");
    expect(workflow).toContain('cron: "*/10 * * * *"');
    // Widened from every 5 minutes as part of the database-usage repair —
    // still frequent enough for "new job, minutes later", at half the
    // invocation count.
    expect(workflow).not.toContain('cron: "*/5 * * * *"');
    expect(workflow).toContain("/api/cron/job-ingestion/fresh");
    expect(workflow).toContain("/api/cron/job-ingestion/standard");
    expect(workflow).toContain("/api/cron/job-ingestion/maintenance");
    // The secret is passed as a bearer token, never interpolated into a URL
    // where it would land in a log line.
    expect(workflow).not.toMatch(/https:\/\/[^\s]*CRON_SECRET/);
  });

  it("does not re-create a recurring QStash schedule for live-discovery", async () => {
    // The QStash-based schedule creator used to be a second, independent
    // 5-minute scheduler for the exact same discovery work GitHub Actions'
    // "fresh" lane already runs. POST must stay permanently disabled so
    // nothing can silently re-arm that duplication.
    const route = await repoFile("src/app/api/system/live-discovery/schedule/route.ts");
    expect(route).toMatch(/export async function POST\(\)/);
    const postBody = route.slice(route.indexOf("export async function POST("));
    expect(postBody).not.toMatch(/qstash\(`\/schedules\/\$\{destination\}`/);
    expect(postBody).toMatch(/status:\s*410/);
  });
});
