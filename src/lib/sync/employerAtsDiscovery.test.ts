// Quality gates 7-10: an employer the approved CSV has never heard of can be
// resolved to its real job board from the employer's OWN careers page.
//
// Every case here uses a stubbed fetch, so the suite is deterministic and
// makes no network calls. The markup shapes are the ones these vendors
// actually emit on employer careers pages.

import { describe, expect, it, vi } from "vitest";
import { detectAtsFromText, detectAtsForCareersPage } from "@/lib/ats/detect";
import { resolveAtsForCompany } from "@/lib/ats/resolve";
import { employerDomainFrom } from "@/lib/sync/jobrightSignalDetail";

function pageResponse(body: string, finalUrl: string): Response {
  return {
    ok: true,
    status: 200,
    url: finalUrl,
    text: async () => body,
  } as unknown as Response;
}

function stubCareersPage(body: string, finalUrl = "https://acme.com/careers") {
  return vi.fn(async () => pageResponse(body, finalUrl)) as unknown as typeof fetch;
}

describe("Gate 7 — Greenhouse", () => {
  it("resolves the board slug from an embedded Greenhouse iframe", () => {
    expect(
      detectAtsFromText(
        '<iframe src="https://boards.greenhouse.io/tenstorrent?for=tenstorrent"></iframe>',
      ),
    ).toEqual({ atsType: "greenhouse", atsIdentifier: "tenstorrent" });
  });

  it("also handles the newer job-boards.greenhouse.io host", () => {
    expect(detectAtsFromText('<a href="https://job-boards.greenhouse.io/acme-labs/jobs/1">')).toEqual(
      { atsType: "greenhouse", atsIdentifier: "acme-labs" },
    );
  });
});

describe("Gate 8 — Lever", () => {
  it("resolves the board slug from a careers-page link", () => {
    expect(detectAtsFromText('<a href="https://jobs.lever.co/matterport/abc-def">Openings</a>')).toEqual(
      { atsType: "lever", atsIdentifier: "matterport" },
    );
  });
});

describe("Gate 9 — Ashby", () => {
  it("resolves the board slug from a careers-page link", () => {
    expect(detectAtsFromText('<a href="https://jobs.ashbyhq.com/openai/1234">Careers</a>')).toEqual(
      { atsType: "ashby", atsIdentifier: "openai" },
    );
  });
});

describe("Gate 10 — Workday", () => {
  it("keeps the Workday shard in the identifier so a wd5 tenant is not routed to wd1", () => {
    expect(detectAtsFromText("https://micron.wd1.myworkdayjobs.com/External/job/Boise/Intern")).toEqual(
      { atsType: "workday", atsIdentifier: "micron.wd1/External" },
    );
    expect(detectAtsFromText("https://example.wd12.myworkdayjobs.com/University/job/x")).toEqual({
      atsType: "workday",
      atsIdentifier: "example.wd12/University",
    });
  });

  it("REGRESSION: skips the locale segment and keeps underscores in the site name", () => {
    // ".../en-US/hubbell_careers/..." previously resolved to the site "en-US",
    // which is not a career site, so every locale-prefixed Workday employer
    // failed to resolve.
    expect(
      detectAtsFromText("https://hubbell.wd5.myworkdayjobs.com/en-US/hubbell_careers/job/x"),
    ).toEqual({ atsType: "workday", atsIdentifier: "hubbell.wd5/hubbell_careers" });
  });

  it("resolves a Workday tenant from an employer careers page", async () => {
    const fetchImpl = stubCareersPage(
      '<html><a href="https://crown.wd1.myworkdayjobs.com/en-US/Crown_Careers/job/1">Search jobs</a></html>',
      "https://crown.com/careers",
    );
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const resolution = await resolveAtsForCompany("Crown Equipment", "https://crown.com/careers", {
        throttleMs: 0,
      });
      expect(resolution).toMatchObject({
        atsType: "workday",
        atsIdentifier: "crown.wd1/Crown_Careers",
        method: "careers-page",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("SmartRecruiters and iCIMS", () => {
  it("resolves a SmartRecruiters company id", () => {
    expect(detectAtsFromText('<a href="https://jobs.smartrecruiters.com/Cargill/744000">')).toEqual({
      atsType: "smartrecruiters",
      atsIdentifier: "Cargill",
    });
  });

  it("resolves an iCIMS tenant", () => {
    expect(detectAtsFromText('https://careers-devon.icims.com/jobs/9999/intern/job')).toEqual({
      atsType: "icims",
      atsIdentifier: "careers-devon",
    });
  });

  it("resolves a SuccessFactors tenant on either shard", () => {
    expect(detectAtsFromText("https://career5.successfactors.eu/career?company=acme")).toEqual({
      atsType: "successfactors",
      atsIdentifier: "career5",
    });
  });
});

describe("careers-page crawling", () => {
  it("prefers evidence from the employer's own page over any guess", async () => {
    const fetchImpl = stubCareersPage(
      '<html><body><a href="https://boards.greenhouse.io/westwin/jobs">See openings</a></body></html>',
    );
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const detected = await detectAtsForCareersPage("https://westwinelements.com/careers");
      expect(detected).toEqual({ atsType: "greenhouse", atsIdentifier: "westwin" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports unknown rather than guessing when the page links to no ATS", async () => {
    const fetchImpl = stubCareersPage("<html><body><p>Email us your resume.</p></body></html>");
    vi.stubGlobal("fetch", fetchImpl);
    try {
      expect(await detectAtsForCareersPage("https://acme.com/careers")).toEqual({
        atsType: "unknown",
        atsIdentifier: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("treats a careers page that redirects straight into the ATS as evidence", async () => {
    const fetchImpl = vi.fn(async () =>
      pageResponse("<html></html>", "https://jobs.lever.co/freeform/1a2b"),
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);
    try {
      expect(await detectAtsForCareersPage("https://freeform.co/careers")).toEqual({
        atsType: "lever",
        atsIdentifier: "freeform",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("company domains are used, never invented", () => {
  it("accepts a website the source published for the employer", () => {
    expect(employerDomainFrom("http://tenstorrent.com")).toBe("tenstorrent.com");
    expect(employerDomainFrom("https://www.pg.com/en-us/")).toBe("pg.com");
    expect(employerDomainFrom("crown.com")).toBe("crown.com");
  });

  it("refuses social and aggregator profiles, which are not careers sites", () => {
    for (const value of [
      "https://www.linkedin.com/company/10629072",
      "https://x.com/tenstorrent",
      "https://www.crunchbase.com/organization/acme",
      "https://jobright.ai/company/acme",
      "https://simplify.jobs/c/acme",
    ]) {
      expect(employerDomainFrom(value)).toBeNull();
    }
  });

  it("refuses anything that is not a real public hostname", () => {
    expect(employerDomainFrom(null)).toBeNull();
    expect(employerDomainFrom("")).toBeNull();
    expect(employerDomainFrom("not a url")).toBeNull();
    expect(employerDomainFrom("http://localhost:3000")).toBeNull();
    expect(employerDomainFrom("http://10.0.0.1/careers")).toBeNull();
  });
});
