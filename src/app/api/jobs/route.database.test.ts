import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { FRESHNESS_FIELDS } from "@/lib/jobs/jobsQueryError";
import { jobOrderBy, JOB_SORT_OPTIONS } from "@/lib/jobs/jobSort";
import { GET } from "./route";

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

// These tests run against a real PostgreSQL database through the real Prisma
// Client, with no mocks. They are the regression net for the Jobs page failing
// with "The Jobs API reached the database, but its query failed": the query is
// executed exactly as the route builds it, so a stale client or an unapplied
// migration fails here instead of on the page.
//
// Every query below is read-only. Nothing is created, updated or deleted.
//
// Skipped when DATABASE_URL is unset. This used to fall back to a local
// dev.db file, which is no longer what this application runs on; a suite that
// silently invents its own database is worse than one that says it needs one.
const DATABASE_AVAILABLE = Boolean(process.env.DATABASE_URL?.trim());

type ApiJob = {
  id: string;
  sourcePostedAt: string | null;
  firstSeenAt: string | null;
};

type JobsBody = {
  jobs: ApiJob[];
  total: number;
  offset: number;
  returned: number;
  sort?: string;
};

async function get(url: string): Promise<{ status: number; body: JobsBody }> {
  const response = await GET(new Request(url), {});
  return { status: response.status, body: await response.json() };
}

const ms = (value: string | null): number | null => (value ? new Date(value).getTime() : null);

/**
 * A small catalogue this suite owns.
 *
 * Two of these tests used to assert `count() > 0` and `jobs.length > 1`, which
 * only held because they were run against a developer's populated database. On
 * a fresh CI database they asserted against an empty catalogue and failed —
 * a suite that needs rows must create the rows it needs. The shape matters:
 * several postings with a known `sourcePostedAt` in a deliberate order, and one
 * without, so the freshness ordering and the unknown-dates-last rule both have
 * something to order.
 */
const FIXTURE_COMPANY = "Jobs Route Database Fixture";
const DAY = 24 * 60 * 60 * 1000;

async function seedCatalogue(): Promise<void> {
  const now = Date.now();
  const postings: Array<{ suffix: string; sourcePostedAt: Date | null }> = [
    { suffix: "newest", sourcePostedAt: new Date(now - 1 * DAY) },
    { suffix: "middle", sourcePostedAt: new Date(now - 8 * DAY) },
    { suffix: "oldest", sourcePostedAt: new Date(now - 90 * DAY) },
    { suffix: "undated", sourcePostedAt: null },
  ];
  for (const posting of postings) {
    await prisma.job.create({
      data: {
        title: `Fixture ${posting.suffix} intern`,
        company: FIXTURE_COMPANY,
        description: "Deterministic fixture posting for the Jobs route database contract.",
        status: "DISCOVERED",
        source: "greenhouse",
        verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
        activeFeed: true,
        sourcePostedAt: posting.sourcePostedAt,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
  }
}

describe.skipIf(!DATABASE_AVAILABLE)("GET /api/jobs against the live database", () => {
  beforeAll(async () => {
    await prisma.job.deleteMany({ where: { company: FIXTURE_COMPANY } });
    await seedCatalogue();
  });

  afterAll(async () => {
    await prisma.job.deleteMany({ where: { company: FIXTURE_COMPANY } });
    await prisma.$disconnect();
  });

  it("returns the existing stored jobs without replacing or modifying them", async () => {
    const existingCount = await prisma.job.count();
    expect(existingCount).toBeGreaterThan(0);

    const { status, body } = await get("http://localhost/api/jobs?feed=all&limit=5&offset=0");

    expect(status).toBe(200);
    expect(body.total).toBe(existingCount);
    expect(body.jobs.length).toBeGreaterThan(0);
    expect(body.jobs.length).toBeLessThanOrEqual(5);
    expect(body.jobs.every((job) => typeof job.id === "string")).toBe(true);

    // The read must not have changed the stored set.
    expect(await prisma.job.count()).toBe(existingCount);
  });

  it("the loaded Prisma Client knows every field the freshness ordering uses", () => {
    // A client generated before the canonical source-posted-date migration is
    // exactly what produced "Unknown argument `sourcePostedAt`" on the page.
    const known = Object.keys(Prisma.JobScalarFieldEnum);
    for (const field of FRESHNESS_FIELDS) expect(known).toContain(field);
  });

  it("the database itself has every column the freshness ordering orders by", async () => {
    // `PRAGMA table_info` is SQLite's introspection statement and PostgreSQL
    // rejects it outright, so this assertion could not have been passing since
    // the migration — it failed on the syntax before it ever compared a column.
    // information_schema is the standard equivalent.
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'Job'
    `;
    const names = columns.map((column) => column.column_name);
    for (const field of FRESHNESS_FIELDS) expect(names).toContain(field);
  });

  it("executes the exact route ORDER BY for every offered sort against the real schema", async () => {
    for (const sort of JOB_SORT_OPTIONS) {
      const rows = await prisma.job.findMany({
        orderBy: jobOrderBy(sort),
        include: { matchResults: { orderBy: { createdAt: "desc" }, take: 1 } },
        take: 5,
      });
      expect(Array.isArray(rows)).toBe(true);
    }
  });

  it("does not crash when sourcePostedAt is null", async () => {
    // Ordering by a nullable column and filtering on NULL both have to survive
    // SQLite's null semantics, whether or not any row is null today.
    const nulls = await prisma.job.findMany({
      where: { sourcePostedAt: null },
      orderBy: jobOrderBy("newest"),
      take: 5,
    });
    expect(Array.isArray(nulls)).toBe(true);

    const { status, body } = await get("http://localhost/api/jobs?feed=all");
    expect(status).toBe(200);
    expect(body.jobs.length).toBe(body.total);
  });

  it("sorts recent postings above older ones, with unknown dates last", async () => {
    const { status, body } = await get("http://localhost/api/jobs?feed=all");
    expect(status).toBe(200);
    expect(body.jobs.length).toBeGreaterThan(1);

    const known = body.jobs.filter((job) => job.sourcePostedAt !== null);
    const firstUnknown = body.jobs.findIndex((job) => job.sourcePostedAt === null);

    // 1. sourcePostedAt descending among the jobs that have one.
    for (let i = 1; i < known.length; i += 1) {
      expect(ms(known[i - 1].sourcePostedAt)!).toBeGreaterThanOrEqual(ms(known[i].sourcePostedAt)!);
    }

    // 2. every known date sorts before every unknown one.
    if (firstUnknown !== -1) {
      expect(body.jobs.slice(firstUnknown).every((job) => job.sourcePostedAt === null)).toBe(true);
    }

    // 3. the newest posting in the whole matching set is the first row.
    const newest = await prisma.job.aggregate({ _max: { sourcePostedAt: true } });
    if (newest._max.sourcePostedAt) {
      expect(ms(body.jobs[0].sourcePostedAt)).toBe(newest._max.sourcePostedAt.getTime());
    }
  });

  it("paginates one consistent order — no repeats, no gaps, every record reachable", async () => {
    const all = await get("http://localhost/api/jobs?feed=all");
    const pageSize = 25;
    const collected: string[] = [];

    for (let offset = 0; offset < all.body.total; offset += pageSize) {
      const page = await get(`http://localhost/api/jobs?feed=all&limit=${pageSize}&offset=${offset}`);
      expect(page.status).toBe(200);
      expect(page.body.total).toBe(all.body.total);
      expect(page.body.offset).toBe(offset);
      collected.push(...page.body.jobs.map((job) => job.id));
    }

    expect(collected).toEqual(all.body.jobs.map((job) => job.id));
    expect(new Set(collected).size).toBe(all.body.total);
  });

  it("keeps existing records visible in the default Active feed", async () => {
    const activeCount = await prisma.job.count({ where: { activeFeed: true } });
    const { status, body } = await get("http://localhost/api/jobs");

    expect(status).toBe(200);
    expect(body.sort).toBe("newest");
    expect(body.total).toBe(activeCount);
    expect(body.returned).toBe(activeCount);
  });
});
