import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CRON_LANES,
  LaneBudget,
  boundedEnv,
  isAuthorizedCronRequest,
  leaseIsAvailable,
  leaseKey,
  parseLease,
  runLaneStep,
} from "@/lib/cron/lane";
import { selectDueByTier, type TieredPollCandidate } from "@/lib/sync/companyDiscovery";

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

describe("the lanes are actually wired up", () => {
  async function repoFile(relative: string): Promise<string> {
    return readFile(path.join(process.cwd(), relative), "utf8");
  }

  it("ships a route file for every declared lane", async () => {
    for (const lane of CRON_LANES) {
      const source = await repoFile(`src/app/api/cron/job-ingestion/${lane}/route.ts`);
      expect(source, `${lane} lane must authenticate`).toContain("isAuthorizedCronRequest");
      expect(source, `${lane} lane must take a lease`).toContain("acquireLane");
      expect(source, `${lane} lane must release its lease`).toContain("releaseLane");
      expect(source, `${lane} lane must honour the paused switch`).toContain("isSchedulerPaused");
    }
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

  it("declares only lane routes in vercel.json, at schedules the Hobby plan allows", async () => {
    const vercel = JSON.parse(await repoFile("vercel.json")) as {
      crons?: { path: string; schedule: string }[];
    };
    const crons = vercel.crons ?? [];
    expect(crons.length).toBeGreaterThan(0);
    // Hobby allows at most two cron jobs, each at most once per day. Declaring
    // more, or a sub-daily schedule, makes the deployment itself fail.
    expect(crons.length).toBeLessThanOrEqual(2);
    for (const cron of crons) {
      expect(cron.path).toMatch(/^\/api\/cron\/job-ingestion\/(fresh|standard|maintenance)$/);
      const [minute, hour] = cron.schedule.split(" ");
      expect(minute, `${cron.path} must not use a sub-hourly minute field`).toMatch(/^\d+$/);
      expect(hour, `${cron.path} must run at a fixed hour`).toMatch(/^\d+$/);
    }
  });

  it("drives the five-minute fresh lane from the external scheduler", async () => {
    const workflow = await repoFile(".github/workflows/live-job-ingestion.yml");
    expect(workflow).toContain('cron: "*/5 * * * *"');
    expect(workflow).toContain("/api/cron/job-ingestion/fresh");
    expect(workflow).toContain("/api/cron/job-ingestion/standard");
    expect(workflow).toContain("/api/cron/job-ingestion/maintenance");
    // The secret is passed as a bearer token, never interpolated into a URL
    // where it would land in a log line.
    expect(workflow).not.toMatch(/https:\/\/[^\s]*CRON_SECRET/);
  });
});
