// Phenom adapter contract, pinned to the live /widgets response observed on
// www.pgcareers.com on 2026-08-22. All fixtures, no network.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchPhenomJobDescription,
  listPhenomJobs,
  parsePhenomIdentifier,
  phenomDestination,
} from "@/lib/ats/phenom";

const IDENTIFIER = "www.pgcareers.com|PGBPGNGLOBAL";

/** One real row from the live refineSearch response. */
const JOB = {
  jobId: "R000157293",
  reqId: "R000157293",
  jobSeqNo: "PGBPGNGLOBALR000157293EXTERNALENGLOBAL",
  title: "Finance Intern",
  location: "Almaty, Almaty (City), Kazakhstan",
  cityStateCountry: "Almaty, Almaty (City), Kazakhstan",
  applyUrl: "https://pg.wd5.myworkdayjobs.com/1000/job/Almaty/Finance-Intern_R000157293/apply",
  externalApply: true,
  postedDate: "2026-08-19T00:00:00.000+0000",
  dateCreated: "2026-08-13T16:01:31.365+0000",
  type: "Full time",
  descriptionTeaser: "Job LocationAlmatyJob DescriptionDo you have leadership skills…",
};

function json(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("Phenom tenant identifiers", () => {
  it("splits the stored '<careersHost>|<refNum>' form", () => {
    expect(parsePhenomIdentifier(IDENTIFIER)).toEqual({
      careersHost: "www.pgcareers.com",
      refNum: "PGBPGNGLOBAL",
    });
  });

  it("refuses a malformed identifier", () => {
    expect(parsePhenomIdentifier("PGBPGNGLOBAL")).toBeNull();
    expect(parsePhenomIdentifier("nothost|REF")).toBeNull();
  });
});

describe("phenomDestination", () => {
  const tenant = { careersHost: "www.pgcareers.com", refNum: "PGBPGNGLOBAL" };

  it("prefers the employer's own ATS apply URL over the Phenom microsite", () => {
    // Phenom is a career-site layer over a real ATS, so its rows carry the
    // underlying employer destination. That is the better Apply target.
    expect(phenomDestination(tenant, JOB)).toBe(JOB.applyUrl);
  });

  it("falls back to the Phenom job page when the row states no apply URL", () => {
    expect(phenomDestination(tenant, { jobSeqNo: "ABC123" })).toBe(
      "https://www.pgcareers.com/global/en/job/ABC123",
    );
  });

  it("returns null rather than inventing a destination", () => {
    expect(phenomDestination(tenant, { title: "Intern" })).toBeNull();
  });
});

describe("listPhenomJobs", () => {
  it("maps a live refineSearch row onto the shared AtsJob shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ refineSearch: { status: 200, totalHits: 1, data: { jobs: [JOB] } } })),
    );

    const jobs = await listPhenomJobs(IDENTIFIER, "Procter & Gamble");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      sourceJobId: "PGBPGNGLOBALR000157293EXTERNALENGLOBAL",
      requisitionId: "R000157293",
      title: "Finance Intern",
      company: "Procter & Gamble",
      location: "Almaty, Almaty (City), Kazakhstan",
      applyUrl: JOB.applyUrl,
    });
    expect(jobs[0]!.postedAt?.toISOString()).toBe("2026-08-19T00:00:00.000Z");
  });

  it("REGRESSION: never writes the search teaser into the job description", async () => {
    // descriptionTeaser is Phenom's own summary. Storing it would make a
    // synthesized JD indistinguishable from the employer's real one.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ refineSearch: { status: 200, data: { jobs: [JOB] } } })),
    );
    const jobs = await listPhenomJobs(IDENTIFIER, "Procter & Gamble");
    expect(jobs[0]!.description).toBe("");
  });

  it("POSTs refineSearch to the employer's own widgets endpoint", async () => {
    const bodies: Record<string, unknown>[] = [];
    let calledUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calledUrl = url;
        bodies.push(JSON.parse(String(init?.body)));
        return json({ refineSearch: { status: 200, data: { jobs: [] } } });
      }),
    );
    await listPhenomJobs(IDENTIFIER, "Procter & Gamble");
    expect(calledUrl).toBe("https://www.pgcareers.com/widgets");
    expect(bodies.every((body) => body.ddoKey === "refineSearch")).toBe(true);
    expect(bodies.every((body) => body.refNum === "PGBPGNGLOBAL")).toBe(true);
    expect(bodies.map((body) => body.keywords)).toContain("intern");
    expect(bodies.map((body) => body.keywords)).toContain("co-op");
  });

  it("returns nothing rather than throwing when the endpoint fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response));
    expect(await listPhenomJobs(IDENTIFIER, "Procter & Gamble")).toEqual([]);
  });
});

describe("fetchPhenomJobDescription", () => {
  it("reads the employer's real description from the jobDetail widget", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return json({
          jobDetail: { data: { job: { description: "<p>Job Location</p>Almaty<p>…</p>" } } },
        });
      }),
    );
    const description = await fetchPhenomJobDescription(IDENTIFIER, JOB.jobSeqNo);
    expect(description).toBe("<p>Job Location</p>Almaty<p>…</p>");
    expect(body.ddoKey).toBe("jobDetail");
    expect(body.jobSeqNo).toBe(JOB.jobSeqNo);
  });

  it("returns null when the vendor gives no description", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ jobDetail: { data: { job: {} } } })));
    expect(await fetchPhenomJobDescription(IDENTIFIER, "x")).toBeNull();
  });
});
