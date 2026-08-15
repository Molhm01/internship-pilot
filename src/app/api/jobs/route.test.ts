import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const createJob = vi.fn();
const scheduleInitialAiMatch = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    job: {
      findMany: (...args: unknown[]) => findMany(...args),
      create: (...args: unknown[]) => createJob(...args),
    },
  },
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
  scheduleInitialAiMatch: (...args: unknown[]) => scheduleInitialAiMatch(...args),
}));

import { GET, POST } from "./route";

const existingJobs = [
  {
    id: "job-existing-1",
    title: "Firmware Intern",
    company: "Signal Labs",
    location: "Newark, NJ",
    status: "DISCOVERED",
    workplaceType: "Remote",
    matchScore: 84,
    eligibilityStatus: "Pass",
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
    status: "SAVED",
    workplaceType: "On Site",
    matchScore: 62,
    eligibilityStatus: "Unknown",
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
    findMany.mockResolvedValue(existingJobs);
    createJob.mockResolvedValue({ id: "job-new", title: "New Firmware Intern" });
    scheduleInitialAiMatch.mockResolvedValue({ scheduled: true, reason: "SCHEDULED" });
  });

  it("returns 200 with existing jobs and preserves job fields", async () => {
    const response = await GET(new Request("http://localhost/api/jobs?feed=all"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.total).toBe(2);
    expect(body.jobs.map((job: { id: string }) => job.id)).toEqual([
      "job-existing-1",
      "job-existing-2",
    ]);
    expect(body.jobs[0]).toMatchObject({
      matchScore: 84,
      eligibilityStatus: "Pass",
      verificationStatus: "ACTIVE_SOURCE_LISTED",
      sourceListingUrl: "https://source.example/jobs/1",
      officialApplicationUrl: "https://employer.example/apply/1",
      matchResults: [{ score: 84, eligibility: "Pass" }],
    });
  });

  it("preserves database filters, JSON filters, ordering, and pagination", async () => {
    const response = await GET(new Request(
      "http://localhost/api/jobs?feed=all&location=Newark&status=DISCOVERED&workplaceType=Remote&matchScoreMin=70&disciplines=firmware&graduationYear=2027&limit=1&offset=0",
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        // `mode` is required on PostgreSQL to keep the case-insensitive
        // matching SQLite gave this filter for free.
        location: { contains: "Newark", mode: "insensitive" },
        status: "DISCOVERED",
        workplaceType: "Remote",
        matchScore: { gte: 70 },
      },
      // Newest SOURCE posting first — never newest row-insert first.
      orderBy: [
        { sourcePostedAt: "desc" },
        { sourceRowIndex: "asc" },
        { firstSeenAt: "desc" },
        { id: "desc" },
      ],
      include: {
        matchResults: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
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

    const response = await GET(new Request("http://localhost/api/jobs"));

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

    const response = await GET(new Request("http://localhost/api/jobs?sort=newest"));
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
    }));

    expect(response.status).toBe(201);
    expect(createJob).toHaveBeenCalledOnce();
    expect(scheduleInitialAiMatch).toHaveBeenCalledWith("job-new");
    expect(createJob.mock.invocationCallOrder[0]).toBeLessThan(scheduleInitialAiMatch.mock.invocationCallOrder[0]);
  });
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
    matchScore: 91,
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
    matchScore: 88,
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
  const body = await (await GET(new Request(url))).json();
  return body.jobs.map((job: { id: string }) => job.id);
}

describe("GET /api/jobs default freshness ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findMany.mockResolvedValue(freshnessFixture);
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
    const body = await (await GET(new Request("http://localhost/api/jobs?feed=all&sort=match"))).json();
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
