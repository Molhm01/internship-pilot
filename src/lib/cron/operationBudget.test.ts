import { describe, it, expect, beforeAll, beforeEach } from "vitest";

/**
 * Regression protection for the database-usage repair (see the DATABASE
 * USAGE DIAGNOSTIC / DATABASE EFFICIENCY REPAIR reports).
 *
 * These tests run against a real Postgres database — the same one every
 * other `*.database.test.ts` / DB-backed suite in this repo uses — and are
 * skipped when DATABASE_URL is unset, matching the house convention (see
 * src/app/api/jobs/route.database.test.ts). They exist to catch exactly the
 * regression that produced the original ~144,100 ops/month overage: a
 * recurring pipeline silently starting to issue many more Prisma calls than
 * it needs to, on an empty or near-empty tick.
 *
 * Query COUNT is what's asserted (via PRISMA_OPERATION_BUDGET_TRACKING),
 * matching how every estimate in both reports was built — not row count,
 * which Prisma's own operation billing does not key off either.
 */

process.env.PRISMA_OPERATION_BUDGET_TRACKING = "1";

const DATABASE_AVAILABLE = Boolean(process.env.DATABASE_URL?.trim());

describe.skipIf(!DATABASE_AVAILABLE)("recurring-pipeline operation budgets", () => {
  let prisma: typeof import("@/lib/db").prisma;
  let resetPrismaOperationCounter: typeof import("@/lib/db").resetPrismaOperationCounter;
  let getPrismaOperationCount: typeof import("@/lib/db").getPrismaOperationCount;

  beforeAll(async () => {
    const db = await import("@/lib/db");
    db.resetPrismaClientForTests();
    ({ prisma, resetPrismaOperationCounter, getPrismaOperationCount } = db);
  });

  beforeEach(() => {
    resetPrismaOperationCounter();
  });

  it("checkDue costs exactly one query for any number of named steps", async () => {
    const { checkDue } = await import("@/lib/cron/dueGate");
    await checkDue([
      { name: "budget-test:a", intervalMs: 60_000 },
      { name: "budget-test:b", intervalMs: 60_000 },
      { name: "budget-test:c", intervalMs: 60_000 },
    ]);
    expect(getPrismaOperationCount()).toBe(1);
  });

  it("markRan costs exactly one write", async () => {
    const { markRan } = await import("@/lib/cron/dueGate");
    await markRan("budget-test:markRan");
    expect(getPrismaOperationCount()).toBe(1);
  });

  it("an empty live-discovery queue drain costs at most 2 operations (empty fresh tick)", async () => {
    const { processLiveDiscoveryQueue } = await import("@/lib/sync/liveDiscoveryQueue");
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: "liveDiscovery:event:" } } });
    resetPrismaOperationCounter();

    const result = await processLiveDiscoveryQueue(60);
    expect(result.due).toBe(0);
    // The empty-work fast path (pass #1) must skip the company-table read
    // entirely when nothing is due — only the initial rows fetch runs.
    expect(getPrismaOperationCount()).toBeLessThanOrEqual(2);
  });

  it("an empty supplemental-radar queue drain costs at most 2 operations (empty fresh tick)", async () => {
    const { processSupplementalRadarQueue } = await import("@/lib/sync/supplementalRadarQueue");
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: "supplementalRadar:event:" } } });
    resetPrismaOperationCounter();

    const result = await processSupplementalRadarQueue(80);
    expect(result.due).toBe(0);
    expect(getPrismaOperationCount()).toBeLessThanOrEqual(2);
  });

  it("a tiered ATS poll with nothing due costs exactly one query, regardless of catalog size", async () => {
    const { runTieredDuePoll } = await import("@/lib/sync/companyDiscovery");
    // A due-far-in-the-future filter guarantees zero due companies without
    // depending on (or mutating) whatever the shared test database's Company
    // table currently contains.
    const result = await runTieredDuePoll({
      tiers: ["A"],
      limit: 10,
      now: new Date(0), // due filter is `nextCheckAt <= now`; epoch matches nothing seeded with a real nextCheckAt
    });
    expect(result.checked).toBe(0);
    expect(getPrismaOperationCount()).toBe(1);
  });

  it("a cached catalog-health request costs zero additional operations on a warm hit (health request)", async () => {
    const { getCachedCatalogHealth } = await import("@/lib/sync/liveDiscoveryHealthCache");
    const first = await getCachedCatalogHealth();
    expect(first.fresh).toBe(true);
    expect(getPrismaOperationCount()).toBeGreaterThan(0);

    resetPrismaOperationCounter();
    const second = await getCachedCatalogHealth();
    expect(second.fresh).toBe(false);
    expect(second.computedAt).toBe(first.computedAt);
    // In-process memory cache hit: no DB call at all, not even a 1-row cache read.
    expect(getPrismaOperationCount()).toBe(0);
  });

  it("a cached scheduler-status request costs zero additional operations on a warm hit (scheduler-status request)", async () => {
    const { getCachedSchedulerHealth } = await import("@/lib/sync/schedulerState");
    const first = await getCachedSchedulerHealth();
    expect(getPrismaOperationCount()).toBeGreaterThan(0);

    resetPrismaOperationCounter();
    const second = await getCachedSchedulerHealth();
    expect(second.computedAt).toBe(first.computedAt);
    expect(getPrismaOperationCount()).toBe(0);
  });

  it("a standard-lane tick with nothing due skips public-direct-feeds, Intern List, and hydration entirely", async () => {
    const { checkDue, markRan } = await import("@/lib/cron/dueGate");
    const now = new Date();
    // Simulate "just ran" for all three gated steps, then confirm none of
    // them are due again immediately afterward — this is the guard that
    // keeps a standard-lane tick cheap between each step's own interval.
    await markRan("standard:publicDirectFeeds", now);
    await markRan("standard:internList", now);
    await markRan("standard:qualityHydration", now);
    resetPrismaOperationCounter();

    const due = await checkDue(
      [
        { name: "standard:publicDirectFeeds", intervalMs: 3 * 60 * 60 * 1000 },
        { name: "standard:internList", intervalMs: 2 * 60 * 60 * 1000 },
        { name: "standard:qualityHydration", intervalMs: 2 * 60 * 60 * 1000 },
      ],
      now,
    );
    expect(due["standard:publicDirectFeeds"]).toBe(false);
    expect(due["standard:internList"]).toBe(false);
    expect(due["standard:qualityHydration"]).toBe(false);
    // One batched query decided all three steps were not due — the whole
    // point of gating them is that this is the entire cost.
    expect(getPrismaOperationCount()).toBe(1);
  });
});
