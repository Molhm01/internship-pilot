import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalJobsUrl,
  fetchJobsPage,
  JobsApiError,
  jobsListViewState,
} from "./jobsApi";

describe("canonical Jobs API client", () => {
  it("builds the canonical endpoint with existing filters and pagination", () => {
    const params = new URLSearchParams({
      location: "Newark",
      matchScoreMin: "70",
      limit: "60",
      offset: "0",
    });

    expect(canonicalJobsUrl(params)).toBe(
      "/api/jobs?location=Newark&matchScoreMin=70&limit=60&offset=0",
    );
  });

  it("fetches jobs from the canonical endpoint", async () => {
    const fetcher = vi.fn(async () => Response.json({
      jobs: [{ id: "job-1" }],
      total: 1,
      offset: 0,
      returned: 1,
    })) as unknown as typeof fetch;
    const params = new URLSearchParams({ limit: "60", offset: "0" });

    await expect(fetchJobsPage<{ id: string }>(params, fetcher)).resolves.toMatchObject({
      jobs: [{ id: "job-1" }],
      total: 1,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/jobs?limit=60&offset=0",
      { cache: "no-store" },
    );
  });

  it("distinguishes a missing route from a database query failure", async () => {
    const missingRoute = vi.fn(async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
    const databaseFailure = vi.fn(async () => Response.json(
      { error: "query failed", code: "JOBS_QUERY_FAILED" },
      { status: 500 },
    )) as unknown as typeof fetch;

    await expect(fetchJobsPage(new URLSearchParams(), missingRoute)).rejects.toMatchObject({
      kind: "route_missing",
      status: 404,
    } satisfies Partial<JobsApiError>);
    await expect(fetchJobsPage(new URLSearchParams(), databaseFailure)).rejects.toMatchObject({
      kind: "database_query_failed",
      status: 500,
      code: "JOBS_QUERY_FAILED",
    } satisfies Partial<JobsApiError>);
  });

  it("does not represent a real server failure as a successful empty result", async () => {
    const serverFailure = vi.fn(async () => Response.json(
      { error: "unexpected failure" },
      { status: 500 },
    )) as unknown as typeof fetch;

    await expect(fetchJobsPage(new URLSearchParams(), serverFailure)).rejects.toMatchObject({
      kind: "server_failure",
    } satisfies Partial<JobsApiError>);
    expect(jobsListViewState({ loading: false, error: "Server failed", jobCount: 0 })).toBe("error");
    expect(jobsListViewState({ loading: false, error: null, jobCount: 0 })).toBe("empty");
  });

  it("keeps the Jobs page wired to the canonical client instead of a legacy URL", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/(app)/jobs/page.tsx"), "utf8");

    expect(source).toContain("fetchJobsPage<JobCardData>(queryFor(");
    expect(source).toContain("fetchJobCounts<JobCounts>()");
    expect(source).not.toContain("fetch(`/api/jobs?");
    // Both the first page and "Load more" must go through the same query
    // builder, so paging can never fetch a differently-sorted batch.
    expect(source).toContain("applyJobSort(buildJobsQuery(filters), sort)");
  });
});
