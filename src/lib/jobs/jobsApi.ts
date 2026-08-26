export const JOBS_LIST_ENDPOINT = "/api/jobs";
export const JOBS_COUNTS_ENDPOINT = `${JOBS_LIST_ENDPOINT}/counts`;

export type JobsPageResponse<TJob> = {
  jobs: TJob[];
  total: number;
  allActiveTotal?: number;
  offset: number;
  returned: number;
  nextOffset?: number | null;
  hasMore?: boolean;
  limit?: number;
  view?: string;
  profileReady?: boolean;
  scoreReadinessMessage?: string | null;
  /** The sort the server actually applied (echoed back, already validated). */
  sort?: string;
};

export type JobsApiErrorKind =
  | "route_missing"
  | "database_query_failed"
  | "server_failure"
  | "network_failure"
  | "invalid_response";

export class JobsApiError extends Error {
  constructor(
    message: string,
    public readonly kind: JobsApiErrorKind,
    public readonly status: number | null,
    public readonly code: string | null = null,
  ) {
    super(message);
    this.name = "JobsApiError";
  }
}

export function canonicalJobsUrl(params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${JOBS_LIST_ENDPOINT}?${query}` : JOBS_LIST_ENDPOINT;
}

async function fetchJson(endpoint: string, fetcher: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(endpoint, { cache: "no-store" });
  } catch {
    throw new JobsApiError(
      `Could not reach the Jobs API at ${endpoint}.`,
      "network_failure",
      null,
    );
  }

  const payload = await response.json().catch(() => null) as {
    error?: unknown;
    code?: unknown;
  } | null;
  const code = typeof payload?.code === "string" ? payload.code : null;

  if (response.status === 404) {
    throw new JobsApiError(
      `Jobs API route missing at ${endpoint}. Rebuild and restart the Internship-AI web process.`,
      "route_missing",
      response.status,
      code,
    );
  }

  if (!response.ok) {
    if (code === "JOBS_QUERY_FAILED" || code === "JOBS_COUNTS_QUERY_FAILED") {
      throw new JobsApiError(
        "The Jobs API reached the database, but its query failed. Check the Internship-AI server log for the detailed error.",
        "database_query_failed",
        response.status,
        code,
      );
    }
    const detail = typeof payload?.error === "string" && payload.error.trim()
      ? ` ${payload.error}`
      : "";
    throw new JobsApiError(
      `Jobs API failed with HTTP ${response.status}.${detail}`,
      "server_failure",
      response.status,
      code,
    );
  }

  if (!payload) {
    throw new JobsApiError(
      "Jobs API returned a successful response that was not valid JSON.",
      "invalid_response",
      response.status,
    );
  }

  return payload;
}

export async function fetchJobsPage<TJob>(
  params: URLSearchParams,
  fetcher: typeof fetch = fetch,
): Promise<JobsPageResponse<TJob>> {
  const endpoint = canonicalJobsUrl(params);
  const payload = await fetchJson(endpoint, fetcher) as Partial<JobsPageResponse<TJob>>;

  if (!Array.isArray(payload.jobs) || typeof payload.total !== "number") {
    throw new JobsApiError(
      "Jobs API returned an invalid jobs-list response.",
      "invalid_response",
      200,
    );
  }

  return {
    jobs: payload.jobs,
    total: payload.total,
    allActiveTotal: typeof payload.allActiveTotal === "number" ? payload.allActiveTotal : undefined,
    offset: typeof payload.offset === "number" ? payload.offset : 0,
    returned: typeof payload.returned === "number" ? payload.returned : payload.jobs.length,
    nextOffset: typeof payload.nextOffset === "number" ? payload.nextOffset : null,
    hasMore: typeof payload.hasMore === "boolean" ? payload.hasMore : undefined,
    limit: typeof payload.limit === "number" ? payload.limit : undefined,
    view: typeof payload.view === "string" ? payload.view : undefined,
    profileReady: typeof payload.profileReady === "boolean" ? payload.profileReady : undefined,
    scoreReadinessMessage: typeof payload.scoreReadinessMessage === "string"
      ? payload.scoreReadinessMessage
      : null,
    sort: typeof payload.sort === "string" ? payload.sort : undefined,
  };
}

export async function fetchJobCounts<TCounts>(
  fetcher: typeof fetch = fetch,
): Promise<TCounts> {
  return await fetchJson(JOBS_COUNTS_ENDPOINT, fetcher) as TCounts;
}

export type JobsListViewState = "loading" | "error" | "empty" | "results";

export function jobsListViewState(input: {
  loading: boolean;
  error: string | null;
  jobCount: number;
}): JobsListViewState {
  if (input.loading) return "loading";
  if (input.error) return "error";
  return input.jobCount === 0 ? "empty" : "results";
}
