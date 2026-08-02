// The single definition of how the Jobs feed is ordered.
//
// Two rules this module exists to enforce:
//
//  1. The default feed is ordered by WHEN THE EMPLOYER POSTED THE JOB
//     (`sourcePostedAt`), never by when this app happened to insert or touch
//     the row. A bulk import of month-old postings must not jump the queue.
//  2. Queue/verification/score state is NEVER a sort key. `scoringState`,
//     `verificationStatus`, `resolutionStatus` and `matchScore` are badges; a
//     three-month-old job that is currently "Scoring" stays below a job posted
//     an hour ago.
//
// The comparator is applied in memory after the database query because two of
// the required tie-breaks cannot be expressed in a single SQL ORDER BY: unknown
// dates must sort last regardless of dialect null semantics, and `sourceRowIndex`
// may only break ties for jobs belonging to the LATEST sync run.

export const JOB_SORT_OPTIONS = ["newest", "oldest", "match", "discovered"] as const;

export type JobSort = (typeof JOB_SORT_OPTIONS)[number];

export const DEFAULT_JOB_SORT: JobSort = "newest";

export const JOB_SORT_LABELS: Record<JobSort, string> = {
  newest: "Newest posted",
  oldest: "Oldest posted",
  match: "Highest AI Match",
  discovered: "Recently discovered",
};

export function parseJobSort(value: string | null | undefined): JobSort {
  const candidate = (value ?? "").trim().toLowerCase();
  return (JOB_SORT_OPTIONS as readonly string[]).includes(candidate)
    ? (candidate as JobSort)
    : DEFAULT_JOB_SORT;
}

/**
 * Attach the selected sort to a request/URL query.
 *
 * Filters are rebuilt from scratch on every change, so the sort has to be
 * re-applied afterwards rather than living inside the filter state — that is
 * what stops "change a filter" from silently snapping the feed back to default.
 * The default sort is left out of the URL so a clean feed keeps a clean link.
 */
export function applyJobSort(params: URLSearchParams, sort: JobSort): URLSearchParams {
  if (sort === DEFAULT_JOB_SORT) params.delete("sort");
  else params.set("sort", sort);
  return params;
}

export type SortableJob = {
  id: string;
  sourcePostedAt?: Date | string | null;
  sourceCapturedAt?: Date | string | null;
  sourceSyncRunId?: string | null;
  sourceRowIndex?: number | null;
  firstSeenAt?: Date | string | null;
  createdAt?: Date | string | null;
  matchScore?: number | null;
  matchResults?: { score: number }[] | null;
};

function time(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function discoveredAt(job: SortableJob): number | null {
  return time(job.firstSeenAt) ?? time(job.createdAt);
}

function score(job: SortableJob): number | null {
  const latest = job.matchResults?.[0]?.score;
  if (typeof latest === "number") return latest;
  return typeof job.matchScore === "number" ? job.matchScore : null;
}

/**
 * Which sync run counts as "the latest" for row-order purposes.
 *
 * Derived from the data itself (the run whose capture timestamp is newest)
 * rather than from a separate query, so the ordering of a page is a pure
 * function of the rows on it. An older sync's row index must never outrank a
 * newer sync's, so only the winning run's indexes are consulted.
 */
export function latestSyncRunId(jobs: SortableJob[]): string | null {
  let bestId: string | null = null;
  let bestCapturedAt = -Infinity;
  for (const job of jobs) {
    if (!job.sourceSyncRunId) continue;
    const capturedAt = time(job.sourceCapturedAt);
    if (capturedAt === null) continue;
    if (capturedAt > bestCapturedAt) {
      bestCapturedAt = capturedAt;
      bestId = job.sourceSyncRunId;
    }
  }
  return bestId;
}

/**
 * Row position within the newest sync. Jobs from an older run (or from a run
 * we cannot identify) get no row-order privilege at all.
 */
function rowIndexInLatestSync(job: SortableJob, latestRunId: string | null): number {
  if (!latestRunId || job.sourceSyncRunId !== latestRunId) return Number.MAX_SAFE_INTEGER;
  return typeof job.sourceRowIndex === "number" ? job.sourceRowIndex : Number.MAX_SAFE_INTEGER;
}

/** Descending by value, with null ALWAYS last (never treated as 0/now). */
function compareDescNullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/** Ascending by value, with null still last — unknown is never "oldest". */
function compareAscNullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

export function compareJobs(a: SortableJob, b: SortableJob, sort: JobSort, latestRunId: string | null): number {
  const postedA = time(a.sourcePostedAt);
  const postedB = time(b.sourcePostedAt);

  if (sort === "match") {
    const byScore = compareDescNullsLast(score(a), score(b));
    if (byScore !== 0) return byScore;
  } else if (sort === "discovered") {
    const byDiscovery = compareDescNullsLast(discoveredAt(a), discoveredAt(b));
    if (byDiscovery !== 0) return byDiscovery;
  } else {
    // 1. the source posting timestamp — unknown dates always last.
    const byPosted = sort === "oldest"
      ? compareAscNullsLast(postedA, postedB)
      : compareDescNullsLast(postedA, postedB);
    if (byPosted !== 0) return byPosted;
  }

  // 2. the source's own row order, but only within the newest sync run.
  const rowA = rowIndexInLatestSync(a, latestRunId);
  const rowB = rowIndexInLatestSync(b, latestRunId);
  if (rowA !== rowB) return rowA - rowB;

  // 3. when we first saw it.
  const byDiscovery = sort === "oldest"
    ? compareAscNullsLast(discoveredAt(a), discoveredAt(b))
    : compareDescNullsLast(discoveredAt(a), discoveredAt(b));
  if (byDiscovery !== 0) return byDiscovery;

  // 4. stable, deterministic tie-break so pagination can never repeat or skip.
  if (a.id === b.id) return 0;
  return sort === "oldest" ? (a.id < b.id ? -1 : 1) : (a.id > b.id ? -1 : 1);
}

/** Order a page of jobs. Pure; does not mutate the input array. */
export function sortJobs<T extends SortableJob>(jobs: T[], sort: JobSort = DEFAULT_JOB_SORT): T[] {
  const latestRunId = latestSyncRunId(jobs);
  return [...jobs].sort((a, b) => compareJobs(a, b, sort, latestRunId));
}

/**
 * Best-effort database ordering for the same intent.
 *
 * SQLite sorts NULLs last on DESC, which already matches "unknown dates last"
 * for the default feed. `sortJobs` is still applied afterwards and is the
 * authority — this only keeps the fetched set deterministic and near-final.
 */
export function jobOrderBy(sort: JobSort) {
  switch (sort) {
    case "oldest":
      return [
        { sourcePostedAt: "asc" as const },
        { sourceRowIndex: "asc" as const },
        { firstSeenAt: "asc" as const },
        { id: "asc" as const },
      ];
    case "match":
      return [
        { matchScore: "desc" as const },
        { sourcePostedAt: "desc" as const },
        { id: "desc" as const },
      ];
    case "discovered":
      return [
        { firstSeenAt: "desc" as const },
        { createdAt: "desc" as const },
        { id: "desc" as const },
      ];
    case "newest":
    default:
      return [
        { sourcePostedAt: "desc" as const },
        { sourceRowIndex: "asc" as const },
        { firstSeenAt: "desc" as const },
        { id: "desc" as const },
      ];
  }
}
