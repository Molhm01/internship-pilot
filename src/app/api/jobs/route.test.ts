import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const countJobs = vi.fn();
const findUserStates = vi.fn();
const createJob = vi.fn();
const scheduleInitialAiMatch = vi.fn();
const upsertUserJobState = vi.fn();
const transaction = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    job: {
      findMany: (...args: unknown[]) => findMany(...args),
      count: (...args: unknown[]) => countJobs(...args),
      create: (...args: unknown[]) => createJob(...args),
    },
    userJobState: {
      upsert: (...args: unknown[]) => upsertUserJobState(...args),
      findMany: (...args: unknown[]) => findUserStates(...args),
    },
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}));

vi.mock("@/lib/matching/profileFingerprint", () => ({
  approvedProfileRevision: vi.fn().mockResolvedValue({ hash: "a".repeat(64), factCount: 2 }),
}));

vi.mock("@/lib/matching/baselineScoring", () => ({
  backfillBaselineScoresForUser: vi.fn().mockResolvedValue({ profileReady: true, baselineWritten: 0 }),
  loadApprovedBaselineProfile: vi.fn().mockResolvedValue({ userId: "test-user", revision: "a".repeat(64), facts: [] }),
  loadAllApprovedBaselineProfiles: vi.fn().mockResolvedValue([{ userId: "test-user", revision: "a".repeat(64), facts: [] }]),
  calculateBaselineScore: vi.fn().mockReturnValue({
    score: 70,
    eligibilityStatus: "Unknown",
    scoreSource: "BASELINE",
    profileRevision: "a".repeat(64),
    jobFingerprint: "b".repeat(64),
    explanation: "{}",
  }),
  baselineStateData: vi.fn().mockReturnValue({
    matchScore: 70,
    eligibilityStatus: "Unknown",
    scoreSource: "BASELINE",
    scoreProfileRevision: "a".repeat(64),
    scoreJobFingerprint: "b".repeat(64),
    scoreExplanation: "{}",
  }),
}));

vi.mock("@/lib/applications/officialDestination", () => ({
  resolveOfficialJobDestination: vi.fn().mockResolvedValue({
    sourceListingUrl: "https://employer.example/jobs/new",
    officialApplicationUrl: "https://employer.example/jobs/new",
    originalJobPostUrl: null,
    resolutionStatus: "RESOLVED",
  }),
  destinationPersistenceData: () => ({
    sourceListingUrl: "https://employer.example/jobs/new",
    officialApplicationUrl: "https://employer.example/jobs/new",
    originalJobPostUrl: null,
    resolutionStatus: "RESOLVED",
  }),
}));

vi.mock("@/lib/matching/initialAiMatchQueue", () => ({
  scheduleInitialAiMatchForAllUsers: (...args: unknown[]) => scheduleInitialAiMatch(...args),
}));

import { GET, POST } from "./route";
import { sortJobs, type JobSort } from "@/lib/jobs/jobSort";
import { loadApprovedBaselineProfile } from "@/lib/matching/baselineScoring";

const existingJobs = [
  {
    id: "job-existing-1",
    title: "Firmware Intern",
    company: "Signal Labs",
    location: "Newark, NJ",
    workplaceType: "Remote",
    userStates: [{ applicationStatus: "DISCOVERED", matchScore: 84, eligibilityStatus: "Pass", scoreProfileRevision: "a".repeat(64), scoreJobFingerprint: "b".repeat(64), saved: false, hidden: false, notes: null }],
    verificationStatus: "ACTIVE_SOURCE_LISTED",
    sourceListingUrl: "https://source.example/jobs/1",
    officialApplicationUrl: "https://employer.example/apply/1",
    disciplineTags: JSON.stringify(["firmware", "embedded"]),
    graduationYears: JSON.stringify([2027]),
    createdAt: new Date("2026-07-31T12:00:00Z"),
    matchResults: [{ score: 84, eligibility: "Pass" }],
  },
  {
    id: "job-existing-2",
    title: "Hardware Intern",
    company: "Board Works",
    location: "Boston, MA",
    workplaceType: "On Site",
    userStates: [{ applicationStatus: "SAVED", matchScore: 62, eligibilityStatus: "Unknown", scoreProfileRevision: "a".repeat(64), scoreJobFingerprint: "b".repeat(64), saved: true, hidden: false, notes: null }],
    verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
    sourceListingUrl: "https://source.example/jobs/2",
    officialApplicationUrl: "https://employer.example/apply/2",
    disciplineTags: JSON.stringify(["hardware"]),
    graduationYears: JSON.stringify([2028]),
    createdAt: new Date("2026-07-30T12:00:00Z"),
    matchResults: [{ score: 62, eligibility: "Unknown" }],
  },
];

describe("GET /api/jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findMany.mockImplementation((args: { skip?: number; take?: number } = {}) => {
      const start = args.skip ?? 0;
      return Promise.resolve(existingJobs.slice(start, start + (args.take ?? existingJobs.length)));
    });
    countJobs.mockResolvedValue(2);
    findUserStates.mockResolvedValue([]);
    createJob.mockResolvedValue({ id: "job-new", title: "New Firmware Intern" });
    scheduleInitialAiMatch.mockResolvedValue({ scheduled: true, reason: "SCHEDULED" });
    upsertUserJobState.mockResolvedValue({ applicationStatus: "DISCOVERED" });
    transaction.mockImplementation((operations: Promise<unknown>[]) => Promise.all(operations));
  });

  it("returns 200 with existing jobs and preserves job fields", async () => {
    const response = await GET(new Request("http://localhost/api/jobs?feed=all"), {});
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.total).toBe(2);
    expect(body.jobs.map((job: { id: string }) => job.id)).toEqual([
      "job-existing-1",
      "job-existing-2",
    ]);
    expect(body.jobs[0]).toMatchObject({
      // Flat, and read from this user's state row.
      status: "DISCOVERED",
      matchScore: 84,
      eligibilityStatus: "Pass",
      verificationStatus: "ACTIVE_SOURCE_LISTED",
      sourceListingUrl: "https://source.example/jobs/1",
      officialApplicationUrl: "https://employer.example/apply/1",
      matchResults: [{ score: 84, eligibility: "Pass" }],
    });
    // The raw relation is projected into the flat fields above and not
    // returned: the client sees "your status", never a list of state rows.
    expect(body.jobs[0]).not.toHaveProperty("userStates");
  });

  it("uses a single user-level profile readiness block instead of null-scored cards", async () => {
    vi.mocked(loadApprovedBaselineProfile).mockResolvedValueOnce(null);
    const response = await GET(new Request("http://localhost/api/jobs"), {});
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      profileReady: false,
      jobs: [],
      scoreReadinessMessage: "Complete your profile to activate job matching.",
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("defaults to a 50-row Fresh page with recent posted and bounded unknown-date jobs", async () => {
    await GET(new Request("http://localhost/api/jobs"), {});
    const freshArgs = findMany.mock.calls.at(-1)?.[0] as { where: { activeFeed: boolean; AND: unknown[] } };
    expect(freshArgs).toMatchObject({
      where: {
        activeFeed: true,
        AND: [{
          OR: [
            { sourcePostedAt: { gte: expect.any(Date), lte: expect.any(Date) } },
            { sourcePostedAt: null, firstSeenAt: { gte: expect.any(Date), lte: expect.any(Date) } },
          ],
        }],
      },
      skip: 0,
      take: 50,
    });

    await GET(new Request("http://localhost/api/jobs?view=all"), {});
    const args = findMany.mock.calls.at(-1)?.[0] as { where: Record<string, unknown> };
    expect(args.where.activeFeed).toBe(true);
    expect(args.where).not.toHaveProperty("sourcePostedAt");
  });

  it("preserves database filters, JSON filters, ordering, and pagination", async () => {
    countJobs
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    const response = await GET(new Request(
      "http://localhost/api/jobs?feed=all&location=Newark&status=DISCOVERED&workplaceType=Remote&matchScoreMin=70&disciplines=firmware&graduationYear=2027&limit=1&offset=0",
    ), {});
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        // `mode` is required on PostgreSQL to keep the case-insensitive
        // matching SQLite gave this filter for free.
        location: { contains: "Newark", mode: "insensitive" },
        workplaceType: "Remote",
        // Status and score are this user's, so they filter the state row
        // rather than the shared job.
        userStates: {
          some: { userId: "test-user", applicationStatus: "DISCOVERED", matchScore: { gte: 70 } },
        },
      }),
      // Newest SOURCE posting first — never newest row-insert first.
      orderBy: [
        { sourcePostedAt: { sort: "desc", nulls: "last" } },
        { firstSeenAt: "desc" },
        { sourceRowIndex: "asc" },
        { id: "desc" },
      ],
      include: {
        matchResults: { where: { userId: "test-user" }, orderBy: { createdAt: "desc" }, take: 1 },
        userStates: { where: { userId: "test-user" }, take: 1 },
      },
    }));
    expect(body).toMatchObject({
      total: 1,
      offset: 0,
      returned: 1,
      jobs: [{ id: "job-existing-1" }],
    });
  });

  it("returns a logged JSON database error instead of an empty list", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    findMany.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(new Request("http://localhost/api/jobs"), {});

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "The stored jobs could not be loaded because the database query failed.",
      code: "JOBS_QUERY_FAILED",
    });
    expect(log).toHaveBeenCalledWith(
      "[api/jobs] jobs query failed",
      expect.objectContaining({ error: "database unavailable" }),
    );
    log.mockRestore();
  });

  it("logs the exact ORM error, its cause and its remedy — without leaking secrets", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The literal error the stale web process produced on the Jobs page.
    const validationError = new Error(
      "\nInvalid `prisma.job.findMany()` invocation in\nC:\\Users\\someone\\Desktop\\Internship-AI\\src\\app\\api\\jobs\\route.ts:107:31\n\n"
      + "Unknown argument `sourcePostedAt`. Available options are marked with ?.",
    );
    validationError.name = "PrismaClientValidationError";
    findMany.mockRejectedValue(validationError);

    const response = await GET(new Request("http://localhost/api/jobs?sort=newest"), {});
    const body = await response.json();

    expect(response.status).toBe(500);
    const [, logged] = log.mock.calls[0] as [string, Record<string, string>];
    expect(logged).toMatchObject({
      requestPath: "/api/jobs",
      sort: "newest",
      cause: "STALE_PRISMA_CLIENT",
      errorName: "PrismaClientValidationError",
    });
    expect(logged.error).toContain("Unknown argument `sourcePostedAt`");
    expect(logged.remedy).toContain("npx prisma generate");
    expect(logged.error).not.toContain("C:\\Users\\someone");
    expect(body.dev).toMatchObject({ cause: "STALE_PRISMA_CLIENT" });
    log.mockRestore();
  });

  it("schedules INITIAL matching only after a manual-entry job is persisted", async () => {
    const response = await POST(new Request("http://localhost/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "New Firmware Intern",
        company: "Signal Labs",
        description: "Build and test embedded firmware, analyze device data, document results, and collaborate with engineers throughout the product lifecycle.",
        url: "https://employer.example/jobs/new",
      }),
    }), {});

    expect(response.status).toBe(201);
    expect(createJob).toHaveBeenCalledOnce();
    expect(scheduleInitialAiMatch).toHaveBeenCalledWith("job-new", { startWorker: false });
    expect(createJob.mock.invocationCallOrder[0]).toBeLessThan(scheduleInitialAiMatch.mock.invocationCallOrder[0]);
  });
});

// Route handlers authenticate through this module. The tests below call them
// directly, so a session has to exist; who it belongs to is exercised by
// src/lib/auth/multiUserIsolation.test.ts against a real database.
vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
  const user = { id: "test-user", email: "test@example.test", name: "Test", image: null, emailVerified: true };
  return {
    ...actual,
    currentUser: async () => user,
    requireUser: async () => user,
    guardSession: async () => null,
    withUser:
      <C>(handler: (request: Request, sessionUser: typeof user, context: C) => Promise<Response>) =>
      async (request: Request, context: C) =>
        handler(request, user, context),
  };
});

// --- freshness ordering (see JOB_FRESHNESS_SORT_AUDIT.md) -------------------

const NOW = new Date("2026-08-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Deliberately handed to the route in the WRONG order, with the stale rows
// carrying the newest local timestamps — the shape of the reported bug.
const freshnessFixture = [
  {
    id: "ats-3-months",
    sourcePostedAt: ago(90 * DAY),
    createdAt: ago(MINUTE),
    updatedAt: ago(MINUTE),
    firstSeenAt: ago(MINUTE),
    scoringState: "SCORING",
    userStates: [{ applicationStatus: "DISCOVERED", matchScore: 91, eligibilityStatus: null, scoreProfileRevision: "a".repeat(64), scoreJobFingerprint: "b".repeat(64), saved: false, hidden: false, notes: null }],
    verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
    disciplineTags: null,
    graduationYears: null,
    matchResults: [],
  },
  {
    id: "ats-8-days",
    sourcePostedAt: ago(8 * DAY),
    createdAt: ago(2 * MINUTE),
    updatedAt: ago(2 * MINUTE),
    firstSeenAt: ago(2 * MINUTE),
    scoringState: "SCORED",
    userStates: [{ applicationStatus: "DISCOVERED", matchScore: 88, eligibilityStatus: null, scoreProfileRevision: "a".repeat(64), scoreJobFingerprint: "b".repeat(64), saved: false, hidden: false, notes: null }],
    verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
    disciplineTags: null,
    graduationYears: null,
    matchResults: [],
  },
  {
    id: "internlist-unknown-date",
    sourcePostedAt: null,
    sourceSyncRunId: "sync-latest",
    sourceRowIndex: 4,
    sourceCapturedAt: ago(MINUTE),
    createdAt: ago(10 * HOUR),
    firstSeenAt: ago(10 * HOUR),
    scoringState: "NOT_SCORED",
    matchScore: null,
    verificationStatus: "Pending",
    disciplineTags: null,
    graduationYears: null,
    matchResults: [],
  },
  {
    id: "internlist-1-hour",
    sourcePostedAt: ago(HOUR),
    sourceSyncRunId: "sync-latest",
    sourceRowIndex: 1,
    sourceCapturedAt: ago(MINUTE),
    createdAt: ago(10 * HOUR),
    firstSeenAt: ago(10 * HOUR),
    scoringState: "NOT_SCORED",
    matchScore: null,
    verificationStatus: "Pending",
    disciplineTags: null,
    graduationYears: null,
    matchResults: [],
  },
  {
    id: "internlist-38-minutes",
    sourcePostedAt: ago(38 * MINUTE),
    sourceSyncRunId: "sync-latest",
    sourceRowIndex: 0,
    sourceCapturedAt: ago(MINUTE),
    createdAt: ago(10 * HOUR),
    firstSeenAt: ago(10 * HOUR),
    scoringState: "QUEUED",
    matchScore: null,
    verificationStatus: "Pending",
    disciplineTags: null,
    graduationYears: null,
    matchResults: [],
  },
];

async function orderedIds(url: string): Promise<string[]> {
  const body = await (await GET(new Request(url), {})).json();
  return body.jobs.map((job: { id: string }) => job.id);
}

describe("GET /api/jobs default freshness ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    countJobs.mockResolvedValue(freshnessFixture.length);
    const enriched = freshnessFixture.map((job) => ({
      ...job,
      userStates: job.userStates ?? [{
        applicationStatus: "DISCOVERED",
        matchScore: job.matchScore ?? 50,
        eligibilityStatus: "Unknown",
        scoreSource: "BASELINE",
        scoreProfileRevision: "a".repeat(64),
        scoreJobFingerprint: "b".repeat(64),
        saved: false,
        hidden: false,
        notes: null,
      }],
    }));
    findMany.mockImplementation((args: { orderBy?: Array<Record<string, unknown>>; skip?: number; take?: number } = {}) => {
      const first = args.orderBy?.[0] ?? {};
      const selected: JobSort = "firstSeenAt" in first
        ? "discovered"
        : JSON.stringify(first).includes("asc")
          ? "oldest"
          : "newest";
      const ordered = sortJobs(enriched, selected);
      const start = args.skip ?? 0;
      return Promise.resolve(ordered.slice(start, start + (args.take ?? ordered.length)));
    });
    findUserStates.mockImplementation((args: { skip?: number; take?: number } = {}) => {
      const ordered = sortJobs(
        enriched.map((job) => ({ ...job, matchScore: job.userStates[0].matchScore })),
        "match",
      );
      const start = args.skip ?? 0;
      return Promise.resolve(ordered.slice(start, start + (args.take ?? ordered.length)).map((job) => ({
        ...job.userStates[0],
        userId: "test-user",
        jobId: job.id,
        job: { ...job, userStates: undefined },
      })));
    });
  });

  it("returns newest source posting first, with unknown dates last", async () => {
    expect(await orderedIds("http://localhost/api/jobs?feed=all")).toEqual([
      "internlist-38-minutes",
      "internlist-1-hour",
      "ats-8-days",
      "ats-3-months",
      "internlist-unknown-date",
    ]);
  });

  it("does not let a scoring, verified, high-scoring old job outrank a fresh one", async () => {
    const order = await orderedIds("http://localhost/api/jobs?feed=all");
    expect(order.indexOf("internlist-38-minutes")).toBeLessThan(order.indexOf("ats-3-months"));
    expect(order.indexOf("internlist-1-hour")).toBeLessThan(order.indexOf("ats-8-days"));
  });

  it("defaults to newest posted when sort is absent or unrecognized", async () => {
    const fallback = await orderedIds("http://localhost/api/jobs?feed=all&sort=whatever");
    expect(fallback).toEqual(await orderedIds("http://localhost/api/jobs?feed=all"));
  });

  it("echoes the applied sort so the client can trust the URL", async () => {
    const body = await (await GET(new Request("http://localhost/api/jobs?feed=all&sort=match"), {})).json();
    expect(body.sort).toBe("match");
  });

  it("honours the other offered sorts", async () => {
    expect((await orderedIds("http://localhost/api/jobs?feed=all&sort=oldest"))[0]).toBe("ats-3-months");
    expect((await orderedIds("http://localhost/api/jobs?feed=all&sort=match"))[0]).toBe("ats-3-months");
    expect((await orderedIds("http://localhost/api/jobs?feed=all&sort=discovered"))[0]).toBe("ats-3-months");
  });

  it("preserves newest-first ordering across pages", async () => {
    const page1 = await orderedIds("http://localhost/api/jobs?feed=all&limit=2&offset=0");
    const page2 = await orderedIds("http://localhost/api/jobs?feed=all&limit=2&offset=2");
    const page3 = await orderedIds("http://localhost/api/jobs?feed=all&limit=2&offset=4");

    expect([...page1, ...page2, ...page3]).toEqual(
      await orderedIds("http://localhost/api/jobs?feed=all"),
    );
    expect(new Set([...page1, ...page2, ...page3]).size).toBe(freshnessFixture.length);
  });

  it("keeps the selected sort while a filter is applied", async () => {
    const filtered = await orderedIds(
      "http://localhost/api/jobs?feed=all&sort=oldest&workplaceType=Remote",
    );
    expect(filtered[0]).toBe("ats-3-months");
  });
});
