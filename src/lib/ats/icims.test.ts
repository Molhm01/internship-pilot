// iCIMS Jibe-feed adapter contract, pinned to the live /api/jobs response
// observed on careers.amd.com on 2026-11-05. All fixtures, no network.

import { afterEach, describe, expect, it, vi } from "vitest";
import { listIcimsJibeJobs } from "@/lib/ats/icims";

/** One real row shape from the live /api/jobs response. */
const ROW = {
  data: {
    slug: "93408",
    req_id: "93408",
    title: "Summer 2027 Software Engineer Intern",
    full_location: "Austin, Texas, United States",
    city: "Austin",
    state: "Texas",
    country: "United States",
    category: [" Student / Intern / Temp"],
    apply_url: "https://global-external-amd.icims.com/jobs/93408/login",
    description: "<p>Description</p>",
    posted_date: "2026-11-04T14:00:00+0000",
  },
};

function json(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("iCIMS Jibe JSON feed", () => {
  it("maps live rows to AtsJob and stops paginating at the reported count", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("keywords=intern")) return json({ jobs: [ROW], count: 1 });
      if (url.includes("keywords=co-op")) return json({ jobs: [], count: 0 });
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await listIcimsJibeJobs("https://careers.amd.com/careers-home/jobs", "AMD");
    expect(jobs).not.toBeNull();
    expect(jobs).toHaveLength(1);
    const job = jobs![0]!;
    expect(job.sourceJobId).toBe("93408");
    expect(job.requisitionId).toBe("93408");
    expect(job.title).toBe("Summer 2027 Software Engineer Intern");
    expect(job.company).toBe("AMD");
    expect(job.location).toBe("Austin, Texas, United States");
    expect(job.applyUrl).toBe("https://global-external-amd.icims.com/jobs/93408/login");
    expect(job.postedAt?.toISOString()).toBe("2026-11-04T14:00:00.000Z");
    expect(job.employmentType).toBe("Intern");
    // The feed lives on the careers-site origin, not the tenant subdomain.
    expect(fetchMock.mock.calls[0]![0]).toContain("https://careers.amd.com/api/jobs");
  });

  it("dedupes rows shared across search terms", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ jobs: [ROW], count: 1 })),
    );
    const jobs = await listIcimsJibeJobs("https://careers.amd.com/careers-home/jobs", "AMD");
    expect(jobs).toHaveLength(1);
  });

  it("returns an empty array when the feed answers with no matching rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ jobs: [], count: 0 })),
    );
    const jobs = await listIcimsJibeJobs("https://careers.amd.com/careers-home/jobs", "AMD");
    expect(jobs).toEqual([]);
  });

  it("returns null when the origin exposes no JSON feed (HTTP error or HTML shell)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => null }) as unknown as Response),
    );
    await expect(listIcimsJibeJobs("https://example.com/jobs", "Example")).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json("<!doctype html>")),
    );
    await expect(listIcimsJibeJobs("https://example.com/jobs", "Example")).resolves.toBeNull();
  });

  it("returns null for an unparseable careersUrl", async () => {
    await expect(listIcimsJibeJobs("not a url", "Example")).resolves.toBeNull();
  });
});
