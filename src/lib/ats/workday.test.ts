import { afterEach, describe, expect, it, vi } from "vitest";
import { listWorkdayJobs } from "@/lib/ats/workday";

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

  it("asks Workday to do the searching instead of filtering a blind page locally", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", bigTenantFetch(calls));
    await listWorkdayJobs("micron.wd1/External", "Micron", () => true);

    const searches = calls
      .filter((call) => call.url.endsWith("/jobs"))
      .map((call) => (call.body as { searchText?: string })?.searchText);
    expect(searches).toContain("intern");
    expect(searches).toContain("co-op");
    expect(searches).not.toContain("");
  });

  it("keeps the tenant shard so a wd5 board is not queried on wd1", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", bigTenantFetch(calls));
    await listWorkdayJobs("hubbell.wd5/hubbell_careers", "Hubbell", () => true);
    expect(calls[0]!.url).toBe(
      "https://hubbell.wd5.myworkdayjobs.com/wday/cxs/hubbell/hubbell_careers/jobs",
    );
  });

  it("defaults the site to External when the identifier has no site", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", bigTenantFetch(calls));
    await listWorkdayJobs("acme", "Acme", () => true);
    expect(calls[0]!.url).toBe("https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/jobs");
  });
});
