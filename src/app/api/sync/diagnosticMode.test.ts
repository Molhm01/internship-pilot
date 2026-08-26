import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Opening /jobs mounts SyncStatusPanel, which unconditionally POSTs
 * /api/sync/run and /api/sync/fresh as soon as the page decides a catch-up
 * is due. A real local-diagnostic session hit exactly this path and made
 * real outbound calls to Jobright/Intern List/public feeds/ATS boards,
 * importing ~1,000 real postings into a disposable database — the opposite
 * of what LOCAL_DIAGNOSTIC_MODE is supposed to guarantee.
 *
 * These tests prove the fix at the one choke point both the automatic
 * catch-up and the manual "Run sync now" button share: the route handler
 * itself. Every external-discovery entry point the handler can reach is
 * mocked, so a failing assertion here means a genuinely new call was made,
 * not a fixture drifting out of sync with the implementation.
 */

vi.mock("@/lib/auth/session", () => ({
  guardSession: vi.fn().mockResolvedValue(null),
}));

const findFirstSyncLog = vi.fn().mockResolvedValue(null);
const createSyncLog = vi.fn().mockResolvedValue({ id: "log-1" });
const updateSyncLog = vi.fn().mockResolvedValue({});
const countJobs = vi.fn().mockResolvedValue(0);

vi.mock("@/lib/db", () => ({
  prisma: {
    syncLog: {
      findFirst: (...args: unknown[]) => findFirstSyncLog(...args),
      create: (...args: unknown[]) => createSyncLog(...args),
      update: (...args: unknown[]) => updateSyncLog(...args),
    },
    job: {
      count: (...args: unknown[]) => countJobs(...args),
    },
  },
}));

const runQueueBatch = vi.fn().mockResolvedValue({});
const runCompanyDiscoverySweep = vi.fn().mockResolvedValue({ checked: 0, totalEligible: 0, stoppedForTimeBudget: false });
const runUsaJobsDiscovery = vi.fn().mockResolvedValue({});
const runInternListOriginalSourceDiscovery = vi.fn().mockResolvedValue({});
const runFreshnessVerificationBatch = vi.fn().mockResolvedValue({});
const runExpandedPublicDirectFeedDiscovery = vi.fn().mockResolvedValue({});
const runMassTechnicalFeedDiscovery = vi.fn().mockResolvedValue({});
const runJobrightFreshDiscovery = vi.fn().mockResolvedValue({});
const reconcileDirectOfficialFeed = vi.fn().mockResolvedValue({});
const runLiveDiscoveryCycle = vi.fn().mockResolvedValue({ newJobs: 0, updatedJobs: 0 });

vi.mock("@/lib/sync/queue", () => ({ runQueueBatch: (...args: unknown[]) => runQueueBatch(...args) }));
vi.mock("@/lib/sync/companyDiscovery", () => ({
  runCompanyDiscoverySweep: (...args: unknown[]) => runCompanyDiscoverySweep(...args),
  runUsaJobsDiscovery: (...args: unknown[]) => runUsaJobsDiscovery(...args),
}));
vi.mock("@/lib/sync/discoveryResolution", () => ({
  runInternListOriginalSourceDiscovery: (...args: unknown[]) => runInternListOriginalSourceDiscovery(...args),
}));
vi.mock("@/lib/sync/freshness", () => ({
  runFreshnessVerificationBatch: (...args: unknown[]) => runFreshnessVerificationBatch(...args),
}));
vi.mock("@/lib/sync/publicDirectFeedsExpanded", () => ({
  runExpandedPublicDirectFeedDiscovery: (...args: unknown[]) => runExpandedPublicDirectFeedDiscovery(...args),
}));
vi.mock("@/lib/sync/massTechnicalFeeds", () => ({
  runMassTechnicalFeedDiscovery: (...args: unknown[]) => runMassTechnicalFeedDiscovery(...args),
}));
vi.mock("@/lib/sync/jobrightFreshDiscovery", () => ({
  runJobrightFreshDiscovery: (...args: unknown[]) => runJobrightFreshDiscovery(...args),
}));
vi.mock("@/lib/jobs/activeFeed", () => ({
  reconcileDirectOfficialFeed: (...args: unknown[]) => reconcileDirectOfficialFeed(...args),
}));
vi.mock("@/lib/sync/liveDiscoveryEngine", () => ({
  runLiveDiscoveryCycle: (...args: unknown[]) => runLiveDiscoveryCycle(...args),
}));

const allDiscoveryMocks = [
  runQueueBatch,
  runCompanyDiscoverySweep,
  runUsaJobsDiscovery,
  runInternListOriginalSourceDiscovery,
  runFreshnessVerificationBatch,
  runExpandedPublicDirectFeedDiscovery,
  runMassTechnicalFeedDiscovery,
  runJobrightFreshDiscovery,
  reconcileDirectOfficialFeed,
  runLiveDiscoveryCycle,
];

describe("LOCAL_DIAGNOSTIC_MODE blocks live discovery", () => {
  const originalFlag = process.env.LOCAL_DIAGNOSTIC_MODE;

  beforeEach(() => {
    vi.clearAllMocks();
    findFirstSyncLog.mockResolvedValue(null);
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.LOCAL_DIAGNOSTIC_MODE;
    else process.env.LOCAL_DIAGNOSTIC_MODE = originalFlag;
  });

  it("POST /api/sync/run makes zero external-discovery calls when LOCAL_DIAGNOSTIC_MODE=true", async () => {
    process.env.LOCAL_DIAGNOSTIC_MODE = "true";
    vi.resetModules();
    const { POST } = await import("./run/route");
    const response = await POST();
    const body = await response.json();

    expect(body.skipped).toBe("local_diagnostic_mode");
    for (const mock of allDiscoveryMocks) expect(mock).not.toHaveBeenCalled();
  });

  it("POST /api/sync/fresh makes zero external-discovery calls when LOCAL_DIAGNOSTIC_MODE=true", async () => {
    process.env.LOCAL_DIAGNOSTIC_MODE = "true";
    vi.resetModules();
    const { POST } = await import("./fresh/route");
    const response = await POST();
    const body = await response.json();

    expect(body.skipped).toBe("local_diagnostic_mode");
    expect(runLiveDiscoveryCycle).not.toHaveBeenCalled();
  });

  it("POST /api/sync/run still runs discovery normally when LOCAL_DIAGNOSTIC_MODE is unset (no regression)", async () => {
    delete process.env.LOCAL_DIAGNOSTIC_MODE;
    vi.resetModules();
    const { POST } = await import("./run/route");
    await POST();

    expect(runCompanyDiscoverySweep).toHaveBeenCalled();
  });

  it("POST /api/sync/fresh still runs discovery normally when LOCAL_DIAGNOSTIC_MODE is unset (no regression)", async () => {
    delete process.env.LOCAL_DIAGNOSTIC_MODE;
    vi.resetModules();
    const { POST } = await import("./fresh/route");
    await POST();

    expect(runLiveDiscoveryCycle).toHaveBeenCalled();
  });
});
