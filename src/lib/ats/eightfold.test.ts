// Eightfold adapter contract, pinned to the live API shape observed on
// careers.gf.com on 2026-08-22. All fixtures, no network.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  eightfoldJobUrl,
  fetchEightfoldJobDescription,
  listEightfoldJobs,
  parseEightfoldIdentifier,
  parseEightfoldSmartApplyJobs,
} from "@/lib/ats/eightfold";

const IDENTIFIER = "careers.gf.com|globalfoundries.com";

function json(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

/** One real row from the live /api/pcsx/search response. */
const POSITION = {
  id: 563980770506355,
  displayJobId: "JR-2604659",
  atsJobId: "JR-2604659",
  name: "Advanced Manufacturing Process Engineering Intern (Summer 2027)",
  locations: ["Essex Junction, Vermont, United States of America"],
  postedTs: 1786665600,
  creationTs: 1786060800,
  workLocationOption: "onsite",
  positionUrl: "/careers/job/563980770506355",
};

const SMART_APPLY_POSITION = {
  id: 43624688,
  name: "2027 Technology, Data, AI & Ventures Summer Internship Program - Data Engineer Intern",
  locations: ["New York,New York,United States"],
  t_create: 1785514511,
  ats_job_id: "94549",
  display_job_id: "94549",
  job_description: "",
  work_location_option: "hybrid",
  canonicalPositionUrl: "https://careers.newyorklife.com/careers/job/43624688",
};

function smartApplyHtml(positions: unknown[]): string {
  const encoded = JSON.stringify({ positions })
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&#34;");
  return `<code id="smartApplyData" style="display:none">${encoded}</code>`;
}

afterEach(() => vi.unstubAllGlobals());

describe("Eightfold tenant identifiers", () => {
  it("splits the stored '<careersHost>|<groupId>' form", () => {
    expect(parseEightfoldIdentifier(IDENTIFIER)).toEqual({
      careersHost: "careers.gf.com",
      groupId: "globalfoundries.com",
    });
  });

  it("refuses a malformed identifier rather than guessing a host", () => {
    expect(parseEightfoldIdentifier("globalfoundries.com")).toBeNull();
    expect(parseEightfoldIdentifier("notahost|group")).toBeNull();
    expect(parseEightfoldIdentifier("")).toBeNull();
  });

  it("builds the canonical job URL on the employer's own careers host", () => {
    expect(eightfoldJobUrl({ careersHost: "careers.gf.com", groupId: "x" }, 42)).toBe(
      "https://careers.gf.com/careers/job/42",
    );
  });
});

describe("listEightfoldJobs", () => {
  it("maps a live search row onto the shared AtsJob shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ status: 200, data: { positions: [POSITION], count: 1 } })),
    );

    const jobs = await listEightfoldJobs(IDENTIFIER, "GlobalFoundries");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      sourceJobId: "563980770506355",
      requisitionId: "JR-2604659",
      title: "Advanced Manufacturing Process Engineering Intern (Summer 2027)",
      company: "GlobalFoundries",
      location: "Essex Junction, Vermont, United States of America",
      workplaceType: "On Site",
      applyUrl: "https://careers.gf.com/careers/job/563980770506355",
    });
    // postedTs is epoch SECONDS on this API; reading it as milliseconds would
    // date every Eightfold posting to 1970.
    expect(jobs[0]!.postedAt?.toISOString()).toBe("2026-08-14T00:00:00.000Z");
  });

  it("asks the vendor to search rather than paging the whole board", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return json({ status: 200, data: { positions: [], count: 0 } });
      }),
    );
    await listEightfoldJobs(IDENTIFIER, "GlobalFoundries");
    expect(calls.every((url) => url.startsWith("https://careers.gf.com/api/pcsx/search"))).toBe(true);
    expect(calls.some((url) => url.includes("query=intern"))).toBe(true);
    expect(calls.some((url) => url.includes("query=co-op"))).toBe(true);
    expect(calls.every((url) => url.includes("domain=globalfoundries.com"))).toBe(true);
  });

  it("sends the employer Referer the API requires", async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        headers = (init?.headers ?? {}) as Record<string, string>;
        return json({ status: 200, data: { positions: [], count: 0 } });
      }),
    );
    await listEightfoldJobs(IDENTIFIER, "GlobalFoundries");
    // Without this the vendor-hosted mirror answers 403 "Not authorized for PCSX".
    expect(headers.Referer).toBe("https://careers.gf.com/careers");
  });

  it("de-duplicates a posting returned by more than one search term", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ status: 200, data: { positions: [POSITION], count: 1 } })),
    );
    const jobs = await listEightfoldJobs(IDENTIFIER, "GlobalFoundries");
    expect(jobs).toHaveLength(1);
  });

  it("returns nothing rather than throwing when the API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response));
    expect(await listEightfoldJobs(IDENTIFIER, "GlobalFoundries")).toEqual([]);
  });

  it("falls back to the current public Smart Apply search page when the legacy API is gone", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes("/api/pcsx/search")) {
          return { ok: false, status: 404 } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          text: async () => smartApplyHtml([SMART_APPLY_POSITION]),
        } as unknown as Response;
      }),
    );

    const jobs = await listEightfoldJobs(
      "careers.newyorklife.com|newyorklife.com",
      "New York Life",
      { searchTerms: [SMART_APPLY_POSITION.name] },
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      sourceJobId: "43624688",
      requisitionId: "94549",
      workplaceType: "Hybrid",
      applyUrl: "https://careers.newyorklife.com/careers/job/43624688",
    });
    expect(calls[1]).toContain("/careers?query=2027%20Technology");
    expect(calls[1]).toContain("domain=newyorklife.com");
  });
});

describe("Smart Apply server-rendered contract", () => {
  it("parses the employer-hosted smartApplyData block without inventing a destination", () => {
    const tenant = { careersHost: "careers.newyorklife.com", groupId: "newyorklife.com" };
    const jobs = parseEightfoldSmartApplyJobs(
      smartApplyHtml([SMART_APPLY_POSITION]),
      tenant,
      "New York Life",
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.title).toContain("Data Engineer Intern");
    expect(jobs[0]!.company).toBe("New York Life");
    expect(jobs[0]!.applyUrl).toBe("https://careers.newyorklife.com/careers/job/43624688");
  });

  it("rejects a canonical URL on a host the employer page does not own", () => {
    const tenant = { careersHost: "careers.newyorklife.com", groupId: "newyorklife.com" };
    const jobs = parseEightfoldSmartApplyJobs(
      smartApplyHtml([{ ...SMART_APPLY_POSITION, canonicalPositionUrl: "https://jobright.ai/jobs/1" }]),
      tenant,
      "New York Life",
    );
    expect(jobs[0]!.applyUrl).toBe("https://careers.newyorklife.com/careers/job/43624688");
  });
});

describe("fetchEightfoldJobDescription", () => {
  it("reads the employer's real job description from position_details", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return json({
          status: 200,
          data: { positions: [{ ...POSITION, jobDescription: "<p>About GlobalFoundries…</p>" }] },
        });
      }),
    );
    const description = await fetchEightfoldJobDescription(IDENTIFIER, "563980770506355");
    expect(description).toBe("<p>About GlobalFoundries…</p>");
    expect(calls[0]).toContain("/api/pcsx/position_details?position_id=563980770506355");
  });

  it("returns null when the vendor has no description, never a placeholder", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ status: 200, data: { positions: [POSITION] } })));
    expect(await fetchEightfoldJobDescription(IDENTIFIER, "1")).toBeNull();
  });
});
