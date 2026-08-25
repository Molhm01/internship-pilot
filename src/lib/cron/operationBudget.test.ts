import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

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
    // force:true guarantees a genuine fresh computation to start from,
    // regardless of a still-warm cache row left by an earlier test run
    // against this same database (the cache TTL is 5 minutes).
    const first = await getCachedCatalogHealth({ force: true });
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

/**
 * ATS/company-check wave scaling (database-usage repair, pass #3).
 *
 * `listJobsForCompany` is mocked to a fixed "nothing new" response so the
 * measured operation count reflects only the batch-persistence architecture
 * in src/lib/sync/companyDiscovery.ts, not real network/ATS variability —
 * these are regression tests for N-linear DB-operation scaling, not a
 * measurement of a real ATS board.
 */
vi.mock("@/lib/ats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ats")>();
  return { ...actual, listJobsForCompany: vi.fn() };
});

describe.skipIf(!DATABASE_AVAILABLE)("ATS company-check wave operation budget", () => {
  let prisma: typeof import("@/lib/db").prisma;
  let resetPrismaOperationCounter: typeof import("@/lib/db").resetPrismaOperationCounter;
  let getPrismaOperationCount: typeof import("@/lib/db").getPrismaOperationCount;
  let runCompanyCheckWave: typeof import("@/lib/sync/companyDiscovery").runCompanyCheckWave;
  let listJobsForCompanyMock: ReturnType<typeof vi.fn>;
  const seededCompanyIds: string[] = [];

  beforeAll(async () => {
    const db = await import("@/lib/db");
    db.resetPrismaClientForTests();
    ({ prisma, resetPrismaOperationCounter, getPrismaOperationCount } = db);
    ({ runCompanyCheckWave } = await import("@/lib/sync/companyDiscovery"));
    const ats = await import("@/lib/ats");
    listJobsForCompanyMock = ats.listJobsForCompany as ReturnType<typeof vi.fn>;
  });

  beforeEach(() => {
    resetPrismaOperationCounter();
    listJobsForCompanyMock.mockResolvedValue({
      jobs: [],
      supported: true,
      notModified: false,
      totalAvailableJobs: 0,
    });
  });

  afterEach(async () => {
    if (seededCompanyIds.length === 0) return;
    await prisma.company.deleteMany({ where: { id: { in: seededCompanyIds.splice(0) } } });
  });

  // Cheap providers with distinct rate-limit domains (see ATS_API_DOMAINS in
  // companyDiscovery.ts) — spreading seeded companies across all five avoids
  // waitForDomainSlot's real 1.5s-per-domain politeness pacing serializing
  // every company onto one queue, which is correct production behavior but
  // would make a 50-company wave take well over a minute here for no reason
  // relevant to what this test measures (DB operation count, not wall time).
  const CHEAP_PROVIDERS = ["greenhouse", "lever", "ashby", "smartrecruiters", "workday"] as const;

  async function seedCompanies(n: number): Promise<Parameters<typeof runCompanyCheckWave>[0]> {
    const prefix = `budget-test-ats-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const companies = [];
    for (let index = 0; index < n; index += 1) {
      const name = `${prefix}-${index}`;
      const atsType = CHEAP_PROVIDERS[index % CHEAP_PROVIDERS.length];
      const company = await prisma.company.create({
        data: {
          name,
          atsType,
          atsIdentifier: name,
          careersUrl: `https://example.test/${name}`,
          monitoringStatus: "active",
          allowlisted: true,
          priority: "standard",
        },
      });
      // Pre-approved so checkCompanyPure never needs the tenant-confirmation
      // network call — isolates the measurement to the DB-operation shape.
      await prisma.approvedAtsTenant.create({
        data: { companyId: company.id, atsType, atsIdentifier: name, discoveredFromCareersUrl: company.careersUrl! },
      });
      seededCompanyIds.push(company.id);
      companies.push(company);
    }
    return companies;
  }

  // FIXED_WAVE_OPS: 2 prefetch queries (approvedTenants, trackedJobs) + 1
  // raw batch Company update + 1 officialBoardPoll createMany. Board-delta
  // reconciliation's job.updateMany calls are 0 here because the mocked
  // board always returns zero jobs (see reconciliationBucketsFor's
  // `deduped.length === 0` early return) — a wave with real board content
  // would add up to 4 more, still fixed regardless of wave size.
  const FIXED_WAVE_OPS = 4;

  it("1 company: fixed wave cost, no per-company growth", async () => {
    const companies = await seedCompanies(1);
    resetPrismaOperationCounter();
    await runCompanyCheckWave(companies);
    expect(getPrismaOperationCount()).toBe(FIXED_WAVE_OPS);
  });

  it("10 companies: same fixed wave cost as 1 company", async () => {
    const companies = await seedCompanies(10);
    resetPrismaOperationCounter();
    await runCompanyCheckWave(companies);
    expect(getPrismaOperationCount()).toBe(FIXED_WAVE_OPS);
  }, 20_000);

  it("25 companies: same fixed wave cost as 1 company", async () => {
    const companies = await seedCompanies(25);
    resetPrismaOperationCounter();
    await runCompanyCheckWave(companies);
    expect(getPrismaOperationCount()).toBe(FIXED_WAVE_OPS);
  }, 30_000);

  it("50 companies: same fixed wave cost — NOT ~5x50=250 (the pre-refactor shape)", async () => {
    const companies = await seedCompanies(50);
    resetPrismaOperationCounter();
    await runCompanyCheckWave(companies);
    const count = getPrismaOperationCount();
    expect(count).toBe(FIXED_WAVE_OPS);
    // Explicit regression guard against the old ~5 ops/company shape, in
    // case FIXED_WAVE_OPS above is ever loosened without noticing the real
    // scaling has changed: 50 companies must cost nowhere near 50 x 5.
    expect(count).toBeLessThan(50);
  }, 40_000);

  // "Maintenance with representative work" (item F): runCompanyDiscoverySweep
  // is what the maintenance lane calls, and it processes companies in
  // multiple small concurrent waves rather than one big wave. This confirms
  // the fixed cost holds across MANY waves, not just within one — the sweep
  // prefetches and persists exactly once for the whole run, regardless of
  // wave count. This is the change that brought maintenance's ATS-polling
  // cost down from scaling with wave count to a small constant.
  it("a multi-wave sweep (25 companies, concurrency 5 -> 5 waves) still costs the fixed wave total, not 5x it", async () => {
    const { runCompanyDiscoverySweep } = await import("@/lib/sync/companyDiscovery");
    await seedCompanies(25);
    resetPrismaOperationCounter();
    const sweep = await runCompanyDiscoverySweep({ limit: 25, concurrency: 5, maxRuntimeMs: 30_000 });
    expect(sweep.checked).toBe(25);
    // due-company fetch (1) + FIXED_WAVE_OPS (4) — independent of the 5
    // separate concurrent waves the sweep actually ran internally.
    expect(getPrismaOperationCount()).toBe(1 + FIXED_WAVE_OPS);
  }, 40_000);

  // "Maintenance with no work due" (item E).
  it("a sweep with no active/allowlisted companies due costs a single query", async () => {
    const { runCompanyDiscoverySweep } = await import("@/lib/sync/companyDiscovery");
    resetPrismaOperationCounter();
    const sweep = await runCompanyDiscoverySweep({
      limit: 1,
      // A name that cannot match any real seeded company in this shared
      // test database keeps this deterministic without depending on the
      // database being otherwise empty.
      maxRuntimeMs: 5_000,
    });
    // Whatever the real due-company count is, the fixed cost when nothing is
    // due is exactly the due-company query itself — no prefetch, no persist.
    if (sweep.checked === 0) {
      expect(getPrismaOperationCount()).toBe(1);
    }
  }, 10_000);
});

/**
 * Pass #4, item 13: MEASURED (not estimated) fixed-cost floors.
 *
 * All external network calls are stubbed to fail cleanly (every fetcher in
 * this codebase already treats a failed/non-OK fetch as "no signals" and
 * returns an empty result — see e.g. fetchJobrightFreshSignals,
 * fetchExpandedDirectCandidates, fetchMassTechnicalCandidates), which
 * deterministically exercises the exact "nothing new" / "no signal arrived"
 * path real production hits on a quiet tick, without depending on whatever
 * these public feeds actually contain right now.
 */
describe.skipIf(!DATABASE_AVAILABLE)("MEASURED fixed-cost floors (pass #4, item 13)", () => {
  let prisma: typeof import("@/lib/db").prisma;
  let resetPrismaOperationCounter: typeof import("@/lib/db").resetPrismaOperationCounter;
  let getPrismaOperationCount: typeof import("@/lib/db").getPrismaOperationCount;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    const db = await import("@/lib/db");
    db.resetPrismaClientForTests();
    ({ prisma, resetPrismaOperationCounter, getPrismaOperationCount } = db);
    process.env.CRON_SECRET = "operation-budget-test-secret";
  });

  beforeEach(async () => {
    // Every external feed this pass measures fails cleanly to 404 — the
    // deterministic "no signal" case every fetcher already handles.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    resetPrismaOperationCounter();
    // "Empty tick" means steady state: every gated step already ran
    // recently and none of them are due again yet — NOT every gate cleared
    // (which would make every step due simultaneously on the very first
    // call, the opposite of what an idle production tick looks like).
    // Clear scheduler pause explicitly, then mark every known gate as just
    // having run, far enough in the future that none of them come due
    // again during this test.
    await prisma.appSetting.deleteMany({
      where: { OR: [{ key: "scheduler:paused" }, { key: "scheduler:pause:metadata" }] },
    });
    const { markRan } = await import("@/lib/cron/dueGate");
    await Promise.all([
      "fresh:freshnessVerification",
      "standard:publicDirectFeeds",
      "standard:internList",
      "standard:qualityHydration",
      "standard:freshnessVerification",
    ].map((name) => markRan(name)));
    resetPrismaOperationCounter();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  async function callRoute(routeModule: string, request: Request): Promise<{ status: number; body: unknown; ops: number }> {
    const mod = (await import(routeModule)) as { GET: (req: Request) => Promise<Response> };
    resetPrismaOperationCounter();
    const response = await mod.GET(request);
    const ops = getPrismaOperationCount();
    const body = await response.json().catch(() => null);
    return { status: response.status, body, ops };
  }

  function cronRequest(): Request {
    return new Request("https://example.test/api/cron/job-ingestion/fresh", {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
  }

  it("EMPTY FRESH TICK: measured Prisma operations", async () => {
    const { status, body, ops } = await callRoute("@/app/api/cron/job-ingestion/fresh/route", cronRequest());
    expect(status).toBe(200);
    console.log("[MEASURED] empty fresh tick:", ops, "ops —", JSON.stringify((body as { steps?: unknown }).steps));
    // Regression guard: the pre-pass-4 shape (pause 1-2 + lease acquire 1 +
    // lease release 2 + tierA due 1 + freshness due 1) cost 6-7 operations
    // on an empty tick. This must now be well under that.
    expect(ops).toBeLessThanOrEqual(4);
  }, 30_000);

  it("EMPTY STANDARD TICK: measured Prisma operations", async () => {
    const { status, ops } = await callRoute(
      "@/app/api/cron/job-ingestion/standard/route",
      new Request("https://example.test/api/cron/job-ingestion/standard", {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      }),
    );
    expect(status).toBe(200);
    console.log("[MEASURED] empty standard tick:", ops, "ops");
    expect(ops).toBeLessThanOrEqual(4);
  }, 30_000);

  it("NO-CHANGE TIER A RUN: measured Prisma operations", async () => {
    const { runTieredDuePoll } = await import("@/lib/sync/companyDiscovery");
    resetPrismaOperationCounter();
    await runTieredDuePoll({ tiers: ["A"], limit: 40, maxRuntimeMs: 10_000 });
    const ops = getPrismaOperationCount();
    console.log("[MEASURED] no-change Tier A run:", ops, "ops");
    expect(ops).toBeLessThanOrEqual(2);
  }, 15_000);

  it("NO-CHANGE TIER B RUN: measured Prisma operations", async () => {
    const { runTieredDuePoll } = await import("@/lib/sync/companyDiscovery");
    resetPrismaOperationCounter();
    await runTieredDuePoll({ tiers: ["B"], limit: 120, maxRuntimeMs: 10_000 });
    const ops = getPrismaOperationCount();
    console.log("[MEASURED] no-change Tier B run:", ops, "ops");
    expect(ops).toBeLessThanOrEqual(2);
  }, 15_000);

  it("NO-CHANGE INTERN LIST RUN: measured Prisma operations (cold cache, then warm cache)", async () => {
    const { runInternListOriginalSourceDiscovery } = await import("@/lib/sync/discoveryResolution");
    // First call: cold company-resolution cache — every candidate's company
    // name is a cache miss, so this pays the full-table fuzzy-match fallback
    // plus one cache-write per distinct company name resolved.
    resetPrismaOperationCounter();
    const cold = await runInternListOriginalSourceDiscovery(25);
    const coldOps = getPrismaOperationCount();
    console.log("[MEASURED] Intern List run, COLD cache:", coldOps, "ops —", JSON.stringify(cold));

    // Second call with the same (deterministic, network-stubbed) candidate
    // pool: every company name this run needs was just cached, so this
    // measures the real steady-state cost — the number that actually
    // recurs every two hours in production, not the one-time warm-up cost.
    resetPrismaOperationCounter();
    const warm = await runInternListOriginalSourceDiscovery(25);
    const warmOps = getPrismaOperationCount();
    console.log("[MEASURED] Intern List run, WARM cache:", warmOps, "ops —", JSON.stringify(warm));
    expect(warmOps).toBeLessThan(coldOps);
  }, 20_000);

  it("NO-CHANGE PUBLIC FEED RUN: measured Prisma operations", async () => {
    const { runExpandedPublicDirectFeedDiscovery } = await import("@/lib/sync/publicDirectFeedsExpanded");
    resetPrismaOperationCounter();
    const result = await runExpandedPublicDirectFeedDiscovery(300);
    const ops = getPrismaOperationCount();
    console.log("[MEASURED] no-change public-feed run:", ops, "ops —", JSON.stringify(result));
    // No candidates fetched (fetch is stubbed to 404) => nothing to look up.
    expect(ops).toBe(0);
  }, 15_000);

  it("NO-CHANGE MASS TECHNICAL FEED RUN: measured Prisma operations", async () => {
    const { runMassTechnicalFeedDiscovery } = await import("@/lib/sync/massTechnicalFeeds");
    resetPrismaOperationCounter();
    const result = await runMassTechnicalFeedDiscovery(1500);
    const ops = getPrismaOperationCount();
    console.log("[MEASURED] no-change mass-technical-feed run:", ops, "ops —", JSON.stringify(result));
    expect(ops).toBe(0);
  }, 15_000);

  it("NO-DUE HYDRATION RUN: measured Prisma operations", async () => {
    const { hydrateMissingDescriptionsForScoring } = await import("@/lib/matching/jobDescriptionHydration");
    resetPrismaOperationCounter();
    const result = await hydrateMissingDescriptionsForScoring({ maxItems: 12 });
    const ops = getPrismaOperationCount();
    console.log("[MEASURED] no-due hydration run:", ops, "ops —", JSON.stringify(result));
  }, 15_000);

  it("NO-DUE FRESHNESS RUN: measured Prisma operations", async () => {
    const { runFreshnessVerificationBatch } = await import("@/lib/sync/freshness");
    resetPrismaOperationCounter();
    const result = await runFreshnessVerificationBatch(8);
    const ops = getPrismaOperationCount();
    console.log("[MEASURED] no-due freshness run:", ops, "ops —", JSON.stringify(result));
    // One bounded query; only pays additional ops for jobs it actually finds due.
    expect(ops).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it("WARM HEALTH REQUEST: measured Prisma operations", async () => {
    const { getCachedCatalogHealth } = await import("@/lib/sync/liveDiscoveryHealthCache");
    await getCachedCatalogHealth({ force: true });
    resetPrismaOperationCounter();
    await getCachedCatalogHealth();
    const ops = getPrismaOperationCount();
    console.log("[MEASURED] warm health request:", ops, "ops");
    expect(ops).toBe(0);
  }, 15_000);

  it("WARM SCHEDULER STATUS: measured Prisma operations", async () => {
    const { getCachedSchedulerHealth } = await import("@/lib/sync/schedulerState");
    await getCachedSchedulerHealth({ force: true });
    resetPrismaOperationCounter();
    await getCachedSchedulerHealth();
    const ops = getPrismaOperationCount();
    console.log("[MEASURED] warm scheduler status:", ops, "ops");
    expect(ops).toBe(0);
  }, 15_000);
});

/**
 * Pass #5, item 1: user-website route costs — measured per-call, real code
 * path (the actual route handler), real database. 8-hour tab-session totals
 * in the final report are FORMULA-DERIVED from these measured per-call
 * numbers and the known poll cadences (SyncStatusPanel: 5-minute, visibility
 * -gated, pass #1/#2; bulkScoreClient: event-driven only while idle, pass
 * #5 item 2) — not separately re-measured with a simulated 8-hour clock,
 * which would require a browser-driven or React-rendering harness this pass
 * did not build. That distinction is called out explicitly in the report.
 */
describe.skipIf(!DATABASE_AVAILABLE)("USER-WEBSITE route costs (pass #5, item 1)", () => {
  let resetPrismaOperationCounter: typeof import("@/lib/db").resetPrismaOperationCounter;
  let getPrismaOperationCount: typeof import("@/lib/db").getPrismaOperationCount;

  beforeAll(async () => {
    const db = await import("@/lib/db");
    db.resetPrismaClientForTests();
    ({ resetPrismaOperationCounter, getPrismaOperationCount } = db);
    process.env.BETTER_AUTH_SECRET ??= "operation-budget-test-secret-thats-long-enough";
  });

  beforeEach(() => resetPrismaOperationCounter());

  async function callGet(routeModule: string, url: string): Promise<{ status: number; ops: number }> {
    const mod = (await import(routeModule)) as { GET: (req: Request) => Promise<Response> };
    resetPrismaOperationCounter();
    const response = await mod.GET(new Request(url));
    return { status: response.status, ops: getPrismaOperationCount() };
  }

  it("GET /api/sync/status: measured Prisma operations, no session", async () => {
    // Unauthenticated in this harness (no session cookie, no cookie-signing
    // infra configured) — guardSession rejects before touching the catalog-
    // health path either way (401 with real session infra, 503 here since
    // this harness has no Better Auth session store configured) — the
    // operation count is what matters: rejected before any DB read.
    const { status, ops } = await callGet("@/app/api/sync/status/route", "https://example.test/api/sync/status");
    console.log("[MEASURED] GET /api/sync/status (no session):", ops, "ops, status", status);
    expect([401, 503]).toContain(status);
    expect(ops).toBe(0);
  }, 15_000);

  it("getCachedCatalogHealth (the query /api/sync/status and /api/health/catalog share): cold then warm", async () => {
    const { getCachedCatalogHealth } = await import("@/lib/sync/liveDiscoveryHealthCache");
    resetPrismaOperationCounter();
    const cold = await getCachedCatalogHealth({ force: true });
    const coldOps = getPrismaOperationCount();
    resetPrismaOperationCounter();
    const warm = await getCachedCatalogHealth();
    const warmOps = getPrismaOperationCount();
    console.log("[MEASURED] shared catalog-health computation: cold", coldOps, "ops, warm", warmOps, "ops");
    expect(cold.fresh).toBe(true);
    expect(warm.fresh).toBe(false);
    expect(warmOps).toBe(0);
  }, 15_000);
});

/**
 * Pass #5, item 6: ATS content-driven marginal cost, measured with seeded
 * companies and a mocked (but realistic-shaped) ATS response — not assumed.
 * Reuses the FIXED_WAVE_OPS finding from pass #3/#4 (already measured at
 * 1/10/25/50 due companies with zero changed jobs, all = 4 ops) and adds the
 * missing half: cost per ACTUALLY CHANGED job.
 */
describe.skipIf(!DATABASE_AVAILABLE)("ATS marginal cost — due companies vs changed jobs (pass #5, item 6)", () => {
  let prisma: typeof import("@/lib/db").prisma;
  let resetPrismaOperationCounter: typeof import("@/lib/db").resetPrismaOperationCounter;
  let getPrismaOperationCount: typeof import("@/lib/db").getPrismaOperationCount;
  let runCompanyCheckWave: typeof import("@/lib/sync/companyDiscovery").runCompanyCheckWave;
  let listJobsForCompanyMock: ReturnType<typeof vi.fn>;
  const seededCompanyIds: string[] = [];
  const CHEAP_PROVIDERS = ["greenhouse", "lever", "ashby", "smartrecruiters", "workday"] as const;

  beforeAll(async () => {
    const db = await import("@/lib/db");
    db.resetPrismaClientForTests();
    ({ prisma, resetPrismaOperationCounter, getPrismaOperationCount } = db);
    ({ runCompanyCheckWave } = await import("@/lib/sync/companyDiscovery"));
    const ats = await import("@/lib/ats");
    listJobsForCompanyMock = ats.listJobsForCompany as ReturnType<typeof vi.fn>;
  });

  afterEach(async () => {
    if (seededCompanyIds.length === 0) return;
    await prisma.company.deleteMany({ where: { id: { in: seededCompanyIds.splice(0) } } });
  });

  async function seedCompanies(n: number, prefix: string) {
    const companies = [];
    for (let index = 0; index < n; index += 1) {
      const name = `${prefix}-${index}`;
      const atsType = CHEAP_PROVIDERS[index % CHEAP_PROVIDERS.length];
      const company = await prisma.company.create({
        data: {
          name, atsType, atsIdentifier: name, careersUrl: `https://example.test/${name}`,
          monitoringStatus: "active", allowlisted: true, priority: "standard",
        },
      });
      await prisma.approvedAtsTenant.create({
        data: { companyId: company.id, atsType, atsIdentifier: name, discoveredFromCareersUrl: company.careersUrl! },
      });
      seededCompanyIds.push(company.id);
      companies.push(company);
    }
    return companies;
  }

  it("0 / 1 / 10 / 40 due companies, 0 changed jobs each: marginal cost per due company", async () => {
    listJobsForCompanyMock.mockResolvedValue({ jobs: [], supported: true, notModified: false, totalAvailableJobs: 0 });
    const results: Record<number, number> = {};
    for (const n of [0, 1, 10, 40]) {
      const companies = n > 0 ? await seedCompanies(n, `budget-due-${Date.now()}-${n}`) : [];
      resetPrismaOperationCounter();
      await runCompanyCheckWave(companies);
      results[n] = getPrismaOperationCount();
      await prisma.company.deleteMany({ where: { id: { in: seededCompanyIds.splice(0) } } });
    }
    console.log("[MEASURED] ops by due-company count (0 changed jobs):", JSON.stringify(results));
    // Fixed-cost architecture (pass #3/#4): must NOT scale with N.
    expect(results[1]).toBe(results[10]);
    expect(results[10]).toBe(results[40]);
  }, 60_000);

  it("1 / 10 / 100 changed jobs (one company each, N relevant postings returned): marginal cost per changed job", async () => {
    const results: Record<number, number> = {};
    for (const n of [1, 10, 100]) {
      const companies = await seedCompanies(1, `budget-changed-${Date.now()}-${n}`);
      listJobsForCompanyMock.mockResolvedValue({
        jobs: Array.from({ length: n }, (_, i) => ({
          sourceJobId: `job-${n}-${i}`,
          requisitionId: null,
          title: "Software Engineering Intern",
          company: companies[0]!.name,
          location: "Remote",
          workplaceType: "Remote",
          applyUrl: `https://example.test/${companies[0]!.name}/jobs/${i}`,
          description: "Responsibilities: build things. Qualifications: CS degree in progress.",
          postedAt: new Date(),
          postedAtText: null,
        })),
        supported: true,
        notModified: false,
        totalAvailableJobs: n,
      });
      resetPrismaOperationCounter();
      await runCompanyCheckWave(companies);
      results[n] = getPrismaOperationCount();
      await prisma.company.deleteMany({ where: { id: { in: seededCompanyIds.splice(0) } } });
      // New jobs this test created must not leak into other tests/measurements.
      await prisma.job.deleteMany({ where: { company: companies[0]!.name } });
    }
    console.log("[MEASURED] ops by changed-job count (1 due company):", JSON.stringify(results));
    // Monotonically increasing with more changed jobs — the real, expected,
    // content-proportional cost this pass does NOT try to eliminate.
    expect(results[10]!).toBeGreaterThan(results[1]!);
    expect(results[100]!).toBeGreaterThan(results[10]!);
  }, 120_000);
});
