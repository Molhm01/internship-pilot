import { afterEach, describe, expect, it, vi } from "vitest";

import {
  employerSearchUrl,
  employerSearchPageUrl,
  extractEmployerSearchResults,
  searchEmployerMirrorJobs,
} from "@/lib/ats/employerPageLinks";

afterEach(() => vi.unstubAllGlobals());

describe("employer-owned job search mirrors", () => {
  it("uses only the search action and input name the employer page publishes", () => {
    const html = `
      <form action="/search" class="search__form">
        <input type="text" name="q" />
      </form>`;
    expect(
      employerSearchUrl(
        html,
        "https://www.walterpmoore.com/careers",
        "Civil Engineering Intern",
      ),
    ).toBe("https://www.walterpmoore.com/search?q=Civil+Engineering+Intern");
  });

  it("refuses a cross-origin search form and does not guess a contract", () => {
    expect(
      employerSearchUrl(
        '<form action="https://search.example/q"><input name="q"></form>',
        "https://employer.example/careers",
        "Intern",
      ),
    ).toBeNull();
    expect(employerSearchUrl("<p>No form</p>", "https://employer.example/careers", "Intern")).toBeNull();
  });

  it("follows only a same-origin Search page published by the employer", () => {
    expect(
      employerSearchPageUrl(
        '<a href="/search"><span>Search</span></a><a href="https://other.example/search">Other</a>',
        "https://www.walterpmoore.com/careers",
      ),
    ).toBe("https://www.walterpmoore.com/search");
  });

  it("keeps only exact-title job pages on the employer's own host", () => {
    const html = `
      <a href="/careers/openings/civil-engineering-intern-2026-4076">Civil Engineering Intern</a>
      <a href="/careers/openings/senior-civil-engineer">Senior Civil Engineer</a>
      <a href="https://other.example/jobs/1">Civil Engineering Intern</a>`;
    expect(
      extractEmployerSearchResults(
        html,
        "https://www.walterpmoore.com/search?q=Civil+Engineering+Intern",
        "Civil Engineering Intern",
      ),
    ).toEqual([
      {
        title: "Civil Engineering Intern",
        url: "https://www.walterpmoore.com/careers/openings/civil-engineering-intern-2026-4076",
      },
    ]);
  });

  it("follows the employer mirror to the exact official iCIMS Apply URL", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (calls.length === 1) {
          return {
            ok: true,
            url: "https://www.walterpmoore.com/careers",
            text: async () => '<a href="/search">Search</a>',
          } as unknown as Response;
        }
        if (calls.length === 2) {
          return {
            ok: true,
            url: "https://www.walterpmoore.com/search",
            text: async () => '<form action="/search"><input name="q"></form>',
          } as unknown as Response;
        }
        if (calls.length === 3) {
          return {
            ok: true,
            url,
            text: async () =>
              '<a href="/careers/openings/mechanical-intern-mep-2026-4004">Mechanical Intern â€“ MEP</a>',
          } as unknown as Response;
        }
        return {
          ok: true,
          url,
          text: async () => `
            <a href="https://careers-walterpmoore.icims.com/jobs/4004/mechanical-intern-%e2%80%93-mep/job?mode=apply&amp;apply=yes">Apply Now</a>
            <a href="https://jobright.ai/jobs/4004">Apply elsewhere</a>`,
        } as unknown as Response;
      }),
    );

    const jobs = await searchEmployerMirrorJobs(
      "https://www.walterpmoore.com/careers",
      "Walter P Moore",
      "Mechanical Intern â€“ MEP",
      "careers-walterpmoore.icims.com",
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: "Mechanical Intern â€“ MEP",
      company: "Walter P Moore",
      requisitionId: "4004",
      applyUrl:
        "https://careers-walterpmoore.icims.com/jobs/4004/mechanical-intern-%e2%80%93-mep/job?mode=apply&apply=yes",
    });
    expect(calls).toHaveLength(4);
  });
});
