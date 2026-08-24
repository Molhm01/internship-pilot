import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWorkdayJobDetail, listWorkdayJobs, parseWorkdayConfiguration, probeWorkdayJobs, workdayExternalPathFromUrl } from "@/lib/ats/workday";

type Call = { url: string; body: unknown };

/**
 * A tenant with thousands of postings where none of the first page is an
 * internship — the shape that used to make this adapter return nothing.
 */
function bigTenantFetch(calls: Call[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });

    if (url.endsWith("/jobs") && init?.method === "POST") {
      const searchText = (body as { searchText?: string })?.searchText ?? "";
      const offset = (body as { offset?: number })?.offset ?? 0;
      if (!searchText) {
        // The unfiltered first page: 20 unrelated senior roles.
        return jsonResponse({
          total: 2718,
          jobPostings: Array.from({ length: 20 }, (_, index) => ({
            title: `Senior Process Engineer ${index}`,
            externalPath: `/job/senior-${index}`,
          })),
        });
      }
      if (searchText === "intern" && offset === 0) {
        return jsonResponse({
          total: 1,
          jobPostings: [
            {
              title: "Intern - Yield Enhancement, Data Analysis",
              externalPath: "/job/Boise/Intern-Yield_JR109076",
              postedOn: "Posted Yesterday",
              bulletFields: ["JR109076"],
            },
          ],
        });
      }
      return jsonResponse({ total: 0, jobPostings: [] });
    }

    return jsonResponse({
      jobPostingInfo: {
        jobReqId: "JR109076",
        location: "Boise, ID - Main Site",
        jobDescription: "<p>Real employer job description.</p>",
        postedOn: "Posted Yesterday",
        startDate: "2026-08-22",
      },
    });
  }) as unknown as typeof fetch;
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Workday board listing", () => {
  it("REGRESSION: finds an internship on a tenant whose first page has none", async () => {
    // Micron's real board carries 2,718 postings; requesting the first 100 with
    // an empty search returned no internships at all, so the adapter reported
    // an employer with open internships as having none.
    const calls: Call[] = [];
    vi.stubGlobal("fetch", bigTenantFetch(calls));

    const jobs = await listWorkdayJobs("micron.wd1/External", "Micron", (title) =>
      /intern|co-?op/i.test(title),
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: "Intern - Yield Enhancement, Data Analysis",
      requisitionId: "JR109076",
      location: "Boise, ID - Main Site",
      description: "Real employer job description.",
    });
  });

  it("uses one unfiltered page for board validation, then asks Workday to search", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", bigTenantFetch(calls));
    await listWorkdayJobs("micron.wd1/External", "Micron", () => true);

    const searches = calls
      .filter((call) => call.url.endsWith("/jobs"))
      .map((call) => (call.body as { searchText?: string })?.searchText);
    expect(searches).toContain("intern");
    expect(searches).toContain("co-op");
    expect(searches.filter((value) => value === "")).toHaveLength(2);
  });

  it("keeps the tenant shard so a wd5 board is not queried on wd1", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", bigTenantFetch(calls));
    await listWorkdayJobs("hubbell.wd5/hubbell_careers", "Hubbell", () => true);
    expect(calls[0]!.url).toBe(
      "https://hubbell.wd5.myworkdayjobs.com/wday/cxs/hubbell/hubbell_careers/jobs",
    );
  });

  it("rejects a missing site instead of silently guessing External", async () => {
    await expect(listWorkdayJobs("acme", "Acme", () => true)).rejects.toMatchObject({
      code: "ATS_CONFIG_MALFORMED",
    });
  });

  it("derives the authoritative shard and site from the employer careers URL", () => {
    expect(parseWorkdayConfiguration(
      "acme/External",
      "https://acme.wd5.myworkdayjobs.com/en-US/University_Careers",
    )).toMatchObject({ tenant: "acme", shard: "wd5", site: "University_Careers", derivedFromCareersUrl: true });
  });

  it("reports total board size and verified pagination separately from internship rows", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", bigTenantFetch(calls));
    const probe = await probeWorkdayJobs("micron.wd1/External", null, "Micron", (title) => /intern/i.test(title));
    expect(probe.totalAvailableJobs).toBe(2718);
    expect(probe.paginationVerified).toBe(true);
    expect(probe.jobs[0]?.postedAt).toBeNull();
    expect(probe.jobs[0]?.postedAtText).toBe("Posted Yesterday");
  });

  it("never treats Workday startDate as posting evidence", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", bigTenantFetch(calls));
    const detail = await fetchWorkdayJobDetail(
      "micron.wd1/External",
      null,
      "/job/Boise/Intern-Yield_JR109076",
    );
    expect(detail).toMatchObject({
      description: "Real employer job description.",
      postedAt: null,
      postedAtText: "Posted Yesterday",
    });
  });

  it("preserves an explicit Workday posting timestamp and full JD", async () => {
    vi.stubGlobal("fetch", (async () => jsonResponse({
      jobPostingInfo: {
        jobDescription: "<p>Responsibilities and qualifications from the official detail.</p>",
        datePosted: "2026-08-23T14:25:00-04:00",
        startDate: "2027-06-01",
      },
    })) as unknown as typeof fetch);
    const detail = await fetchWorkdayJobDetail("acme.wd5/Students", null, "/job/intern-1");
    expect(detail).toMatchObject({
      description: "Responsibilities and qualifications from the official detail.",
      postedAt: null,
      postedAtText: "2026-08-23T14:25:00-04:00",
    });
  });

  it("REGRESSION: extracts Workday's own externalPath out of the public job URL", () => {
    // A job discovered via probeWorkdayJobs stores Workday's own externalPath
    // as sourceJobId. A job discovered via a third-party aggregator (Simplify,
    // Zapply, ApplyGuy, Dreamwork, ...) has THAT service's id there instead —
    // a different identifier scheme, not a broken Workday path.
    expect(workdayExternalPathFromUrl(
      "https://geaerospace.wd5.myworkdayjobs.com/GE_ExternalSite/job/Dayton/Systems-Engineering-Intern_R5030140-1",
      "GE_ExternalSite",
    )).toBe("/job/Dayton/Systems-Engineering-Intern_R5030140-1");
  });

  it("returns null when the URL does not belong to the given site", () => {
    expect(workdayExternalPathFromUrl("https://acme.wd5.myworkdayjobs.com/OtherSite/job/x", "External")).toBeNull();
    expect(workdayExternalPathFromUrl("not-a-url", "External")).toBeNull();
  });

  it("REGRESSION: hydrates detail from the URL when sourceJobId is an aggregator id, not a Workday path", async () => {
    vi.stubGlobal("fetch", (async () => jsonResponse({
      jobPostingInfo: {
        jobDescription: "<p>Real Workday job description reached via URL fallback.</p>",
        datePosted: "2026-08-20T09:00:00-04:00",
      },
    })) as unknown as typeof fetch);
    const detail = await fetchWorkdayJobDetail(
      "geaerospace.wd5/GE_ExternalSite",
      "https://geaerospace.wd5.myworkdayjobs.com/GE_ExternalSite/job/Dayton/Systems-Engineering-Intern_R5030140-1",
      "zapply:5dac8c01", // an aggregator id — not a Workday externalPath
    );
    expect(detail).toMatchObject({ description: "Real Workday job description reached via URL fallback." });
  });
});
