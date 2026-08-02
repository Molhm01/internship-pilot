import { describe, expect, it } from "vitest";
import {
  applyJobSort,
  DEFAULT_JOB_SORT,
  jobOrderBy,
  latestSyncRunId,
  parseJobSort,
  sortJobs,
  type SortableJob,
} from "./jobSort";

const NOW = new Date("2026-08-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function job(overrides: Partial<SortableJob> & { id: string }): SortableJob {
  return {
    firstSeenAt: ago(DAY),
    createdAt: ago(DAY),
    ...overrides,
  };
}

const ids = (jobs: SortableJob[]) => jobs.map((j) => j.id);

describe("default feed ordering (newest posted)", () => {
  it("puts a job posted 38 minutes ago above one posted 1 hour ago", () => {
    const jobs = [
      job({ id: "hour", sourcePostedAt: ago(HOUR) }),
      job({ id: "minutes", sourcePostedAt: ago(38 * MINUTE) }),
    ];
    expect(ids(sortJobs(jobs))).toEqual(["minutes", "hour"]);
  });

  it("puts a job posted 1 hour ago above one posted 8 days ago", () => {
    const jobs = [
      job({ id: "eight-days", sourcePostedAt: ago(8 * DAY) }),
      job({ id: "hour", sourcePostedAt: ago(HOUR) }),
    ];
    expect(ids(sortJobs(jobs))).toEqual(["hour", "eight-days"]);
  });

  it("reproduces the reported feed: minutes, hours and days beat weeks and months", () => {
    const jobs = [
      job({ id: "3-months", sourcePostedAt: ago(90 * DAY) }),
      job({ id: "1-month", sourcePostedAt: ago(30 * DAY) }),
      job({ id: "26-days", sourcePostedAt: ago(26 * DAY) }),
      job({ id: "15-days", sourcePostedAt: ago(15 * DAY) }),
      job({ id: "8-days", sourcePostedAt: ago(8 * DAY) }),
      job({ id: "4-hours", sourcePostedAt: ago(4 * HOUR) }),
      job({ id: "1-hour", sourcePostedAt: ago(HOUR) }),
      job({ id: "46-minutes", sourcePostedAt: ago(46 * MINUTE) }),
      job({ id: "38-minutes", sourcePostedAt: ago(38 * MINUTE) }),
    ];
    expect(ids(sortJobs(jobs))).toEqual([
      "38-minutes",
      "46-minutes",
      "1-hour",
      "4-hours",
      "8-days",
      "15-days",
      "26-days",
      "1-month",
      "3-months",
    ]);
  });
});

describe("queue, score and verification state never reorder the feed", () => {
  it("keeps a 3-month-old scoring job below a 1-hour-old unscored job", () => {
    const jobs = [
      job({
        id: "old-scoring",
        sourcePostedAt: ago(90 * DAY),
        // Queue state is display-only; it is not even part of SortableJob.
        matchScore: 97,
      }),
      job({ id: "fresh-unscored", sourcePostedAt: ago(HOUR), matchScore: null }),
    ];
    expect(ids(sortJobs(jobs))).toEqual(["fresh-unscored", "old-scoring"]);
  });

  it("ignores scores and verification status in newest-first order", () => {
    const jobs = [
      job({ id: "verified-old", sourcePostedAt: ago(20 * DAY), matchScore: 99 }),
      job({ id: "pending-new", sourcePostedAt: ago(2 * HOUR), matchScore: 3 }),
    ];
    expect(ids(sortJobs(jobs))).toEqual(["pending-new", "verified-old"]);
  });

  it("only ranks by score when the user explicitly asks for Highest AI Match", () => {
    const jobs = [
      job({ id: "low-new", sourcePostedAt: ago(HOUR), matchScore: 20 }),
      job({ id: "high-old", sourcePostedAt: ago(40 * DAY), matchScore: 95 }),
      job({ id: "unscored", sourcePostedAt: ago(2 * HOUR), matchScore: null }),
    ];
    expect(ids(sortJobs(jobs, "match"))).toEqual(["high-old", "low-new", "unscored"]);
    expect(ids(sortJobs(jobs, "newest"))).toEqual(["low-new", "unscored", "high-old"]);
  });

  it("prefers the latest MatchResult over the denormalized copy", () => {
    const jobs = [
      job({ id: "stale-copy", sourcePostedAt: ago(HOUR), matchScore: 10, matchResults: [{ score: 90 }] }),
      job({ id: "other", sourcePostedAt: ago(HOUR), matchScore: 50 }),
    ];
    expect(ids(sortJobs(jobs, "match"))).toEqual(["stale-copy", "other"]);
  });
});

describe("local row timestamps never control the default order", () => {
  it("ignores updatedAt entirely — it is not even read", () => {
    const jobs = [
      { ...job({ id: "touched-recently", sourcePostedAt: ago(30 * DAY) }), updatedAt: ago(MINUTE) },
      { ...job({ id: "fresh-posting", sourcePostedAt: ago(2 * HOUR) }), updatedAt: ago(60 * DAY) },
    ];
    expect(ids(sortJobs(jobs))).toEqual(["fresh-posting", "touched-recently"]);
  });

  it("ignores createdAt — a bulk import of old postings does not jump the queue", () => {
    // This is the reported bug in miniature: the ATS batch was inserted last.
    const jobs = [
      job({ id: "bulk-import-old", sourcePostedAt: ago(50 * DAY), createdAt: ago(MINUTE), firstSeenAt: ago(MINUTE) }),
      job({ id: "internlist-fresh", sourcePostedAt: ago(3 * HOUR), createdAt: ago(12 * HOUR), firstSeenAt: ago(12 * HOUR) }),
    ];
    expect(ids(sortJobs(jobs))).toEqual(["internlist-fresh", "bulk-import-old"]);
  });

  it("rediscovering an old job does not make it appear new", () => {
    // lastSeenAt/updatedAt moved to now; sourcePostedAt did not.
    const rediscovered = {
      ...job({ id: "rediscovered", sourcePostedAt: ago(60 * DAY), firstSeenAt: ago(60 * DAY) }),
      lastSeenAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    const fresh = job({ id: "fresh", sourcePostedAt: ago(90 * MINUTE) });
    expect(ids(sortJobs([rediscovered, fresh]))).toEqual(["fresh", "rediscovered"]);
  });
});

describe("unknown source dates", () => {
  it("places unknown-date records after every known recent record", () => {
    const jobs = [
      job({ id: "unknown", sourcePostedAt: null }),
      job({ id: "old-but-known", sourcePostedAt: ago(200 * DAY) }),
      job({ id: "fresh", sourcePostedAt: ago(HOUR) }),
    ];
    expect(ids(sortJobs(jobs))).toEqual(["fresh", "old-but-known", "unknown"]);
  });

  it("keeps unknown-date records last even when sorting oldest first", () => {
    const jobs = [
      job({ id: "unknown", sourcePostedAt: null }),
      job({ id: "old", sourcePostedAt: ago(200 * DAY) }),
      job({ id: "fresh", sourcePostedAt: ago(HOUR) }),
    ];
    expect(ids(sortJobs(jobs, "oldest"))).toEqual(["old", "fresh", "unknown"]);
  });
});

describe("source row order fallback", () => {
  const RUN_NEW = "sync-new";
  const RUN_OLD = "sync-old";

  it("falls back to the current source row order when dates are missing", () => {
    const jobs = [
      job({ id: "row-2", sourcePostedAt: null, sourceSyncRunId: RUN_NEW, sourceRowIndex: 2, sourceCapturedAt: ago(MINUTE) }),
      job({ id: "row-0", sourcePostedAt: null, sourceSyncRunId: RUN_NEW, sourceRowIndex: 0, sourceCapturedAt: ago(MINUTE) }),
      job({ id: "row-1", sourcePostedAt: null, sourceSyncRunId: RUN_NEW, sourceRowIndex: 1, sourceCapturedAt: ago(MINUTE) }),
    ];
    expect(ids(sortJobs(jobs))).toEqual(["row-0", "row-1", "row-2"]);
  });

  it("uses row order to break an exact timestamp tie", () => {
    const tied = ago(HOUR);
    const jobs = [
      job({ id: "second", sourcePostedAt: tied, sourceSyncRunId: RUN_NEW, sourceRowIndex: 5, sourceCapturedAt: ago(MINUTE) }),
      job({ id: "first", sourcePostedAt: tied, sourceSyncRunId: RUN_NEW, sourceRowIndex: 1, sourceCapturedAt: ago(MINUTE) }),
    ];
    expect(ids(sortJobs(jobs))).toEqual(["first", "second"]);
  });

  it("never lets an older sync's row index outrank a newer sync's", () => {
    const tied = ago(HOUR);
    const jobs = [
      // Top row of an OLD run — must not win.
      job({ id: "old-run-row-0", sourcePostedAt: tied, sourceSyncRunId: RUN_OLD, sourceRowIndex: 0, sourceCapturedAt: ago(5 * DAY), firstSeenAt: ago(5 * DAY) }),
      // A late row of the NEWEST run.
      job({ id: "new-run-row-9", sourcePostedAt: tied, sourceSyncRunId: RUN_NEW, sourceRowIndex: 9, sourceCapturedAt: ago(MINUTE), firstSeenAt: ago(2 * DAY) }),
    ];
    expect(ids(sortJobs(jobs))).toEqual(["new-run-row-9", "old-run-row-0"]);
  });

  it("identifies the latest sync run from the newest capture timestamp", () => {
    expect(latestSyncRunId([
      job({ id: "a", sourceSyncRunId: RUN_OLD, sourceCapturedAt: ago(5 * DAY) }),
      job({ id: "b", sourceSyncRunId: RUN_NEW, sourceCapturedAt: ago(MINUTE) }),
    ])).toBe(RUN_NEW);
    expect(latestSyncRunId([job({ id: "a" })])).toBeNull();
  });

  it("falls through to firstSeenAt when no row index applies", () => {
    const tied = ago(HOUR);
    const jobs = [
      job({ id: "seen-earlier", sourcePostedAt: tied, firstSeenAt: ago(10 * DAY) }),
      job({ id: "seen-later", sourcePostedAt: tied, firstSeenAt: ago(DAY) }),
    ];
    expect(ids(sortJobs(jobs))).toEqual(["seen-later", "seen-earlier"]);
  });
});

describe("pagination stability", () => {
  const everything = Array.from({ length: 25 }, (_, i) =>
    job({
      id: `job-${String(i).padStart(2, "0")}`,
      // Deliberately many exact ties, so only the deterministic tie-break
      // keeps pages from repeating or skipping records.
      sourcePostedAt: i % 3 === 0 ? ago(HOUR) : ago((i + 1) * HOUR),
      firstSeenAt: ago(DAY),
    }),
  );

  it("keeps newest-first ordering across every page", () => {
    const ordered = sortJobs(everything);
    const pages = [ordered.slice(0, 10), ordered.slice(10, 20), ordered.slice(20)];
    const flattened = pages.flat();

    expect(ids(flattened)).toEqual(ids(ordered));
    expect(new Set(ids(flattened)).size).toBe(everything.length);

    const times = flattened.map((j) => new Date(j.sourcePostedAt as string).getTime());
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
  });

  it("produces the same order no matter how the rows arrive from the database", () => {
    const shuffled = [...everything].reverse();
    expect(ids(sortJobs(shuffled))).toEqual(ids(sortJobs(everything)));
  });

  it("does not mutate the caller's array", () => {
    const input = [job({ id: "b", sourcePostedAt: ago(2 * HOUR) }), job({ id: "a", sourcePostedAt: ago(HOUR) })];
    sortJobs(input);
    expect(ids(input)).toEqual(["b", "a"]);
  });
});

describe("sort selection", () => {
  it("defaults to newest posted", () => {
    expect(DEFAULT_JOB_SORT).toBe("newest");
    expect(parseJobSort(null)).toBe("newest");
    expect(parseJobSort("")).toBe("newest");
    expect(parseJobSort("nonsense")).toBe("newest");
  });

  it("accepts the four offered sorts", () => {
    expect(parseJobSort("newest")).toBe("newest");
    expect(parseJobSort("oldest")).toBe("oldest");
    expect(parseJobSort("match")).toBe("match");
    expect(parseJobSort("discovered")).toBe("discovered");
  });

  it("orders 'Recently discovered' by when this app first saw the job", () => {
    const jobs = [
      job({ id: "posted-fresh-seen-long-ago", sourcePostedAt: ago(HOUR), firstSeenAt: ago(30 * DAY) }),
      job({ id: "posted-old-seen-now", sourcePostedAt: ago(60 * DAY), firstSeenAt: ago(MINUTE) }),
    ];
    expect(ids(sortJobs(jobs, "discovered"))).toEqual(["posted-old-seen-now", "posted-fresh-seen-long-ago"]);
  });

  it("keeps the sort in the query string, and keeps the default out of it", () => {
    const withFilter = new URLSearchParams("location=Newark");
    expect(applyJobSort(withFilter, "match").toString()).toBe("location=Newark&sort=match");
    expect(applyJobSort(new URLSearchParams("sort=match"), "newest").toString()).toBe("");
  });

  it("never orders the default feed by createdAt, updatedAt or lastSeenAt", () => {
    const keys = jobOrderBy("newest").flatMap((clause) => Object.keys(clause));
    expect(keys[0]).toBe("sourcePostedAt");
    expect(keys).not.toContain("createdAt");
    expect(keys).not.toContain("updatedAt");
    expect(keys).not.toContain("lastSeenAt");
    expect(keys).not.toContain("matchScore");
    expect(keys).not.toContain("scoringState");
    expect(keys).not.toContain("verificationStatus");
  });
});
