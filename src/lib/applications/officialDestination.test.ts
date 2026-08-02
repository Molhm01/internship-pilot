import { describe, expect, it, vi } from "vitest";
import {
  OfficialApplicationUrlUnresolvedError,
  destinationPersistenceData,
  extractOriginalJobPost,
  isValidOfficialApplicationUrl,
  resolveOfficialJobDestination,
  resolveOfficialApplicationDestination,
} from "./officialDestination";

function response(status: number, body = "", location?: string): Response {
  return new Response(body, {
    status,
    headers: {
      ...(location ? { location } : {}),
      "content-type": "text/html",
    },
  });
}

describe("official application destination", () => {
  it("extracts Jobright's Original Job Post JSON field", () => {
    const html = '<script id="__NEXT_DATA__">{"jobResult":{"originalUrl":"https:\\/\\/jobs.lever.co\\/acme\\/123"}}</script>';
    expect(extractOriginalJobPost(html, "https://jobright.ai/jobs/info/1")).toBe(
      "https://jobs.lever.co/acme/123",
    );
  });

  it("resolves Jobright to the original ATS destination and keeps the source separate", async () => {
    const fetchMock = vi.fn(async () =>
      response(200, '<script>{"originalUrl":"https://boards.greenhouse.io/acme/jobs/123"}</script>'),
    );
    const result = await resolveOfficialApplicationDestination(
      { sourceUrl: "https://jobright.ai/jobs/info/abc" },
      fetchMock,
    );
    expect(result.sourceListingUrl).toBe("https://jobright.ai/jobs/info/abc");
    expect(result.officialApplicationUrl).toBe("https://boards.greenhouse.io/acme/jobs/123");
    expect(result.originalJobPostUrl).toBe("https://boards.greenhouse.io/acme/jobs/123");
    expect(result.resolutionMethod).toBe("jobright_original_job_post");
    expect(result.resolutionStatus).toBe("RESOLVED");
  });

  it("resolves Intern List through an aggregator to an employer destination", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("intern-list.com")) {
        return response(302, "", "https://jobright.ai/jobs/info/abc");
      }
      return response(200, '<a href="https://careers.acme.example/jobs/123">Original Job Post</a>');
    });
    const result = await resolveOfficialApplicationDestination(
      { sourceUrl: "https://www.intern-list.com/listing/abc" },
      fetchMock,
    );
    expect(result.officialApplicationUrl).toBe("https://careers.acme.example/jobs/123");
    expect(result.redirectChain).toHaveLength(3);
    expect(result.sourceListingUrl).toBe("https://www.intern-list.com/listing/abc");
    expect(result.resolutionMethod).toBe("intern_list_outbound");
  });

  it.each([
    "https://careers.acme.example/jobs/123",
    "https://jobs.lever.co/acme/123",
    "https://job-boards.greenhouse.io/acme/jobs/123",
    "https://jobs.ashbyhq.com/acme/123",
    "https://acme.wd5.myworkdayjobs.com/jobs/job/123",
    "https://careers-acme.icims.com/jobs/123",
    "https://jobs.smartrecruiters.com/Acme/123",
    "https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/job/123",
    "https://acme.taleo.net/careersection/jobdetail.ftl?job=123",
  ])("accepts direct employer/ATS URL %s", async (url) => {
    const result = await resolveOfficialApplicationDestination(
      { officialApplyUrl: url },
      vi.fn(async () => response(200)),
    );
    expect(result.officialApplicationUrl).toBe(url);
  });

  it.each([
    ["Greenhouse", "https://job-boards.greenhouse.io/acme/jobs/123"],
    ["Lever", "https://jobs.lever.co/acme/123"],
    ["Ashby", "https://jobs.ashbyhq.com/acme/123"],
    ["Workday", "https://acme.wd5.myworkdayjobs.com/en-US/jobs/job/123"],
  ])("resolves a direct %s destination without fetching", async (_name, url) => {
    const fetchMock = vi.fn();
    const result = await resolveOfficialJobDestination({ sourceListingUrl: url, sourceUrl: url }, fetchMock);
    expect(result).toMatchObject({
      sourceListingUrl: null,
      officialApplicationUrl: url,
      resolutionStatus: "RESOLVED",
      resolutionMethod: "supported_ats",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a job-specific employer careers page", async () => {
    const url = "https://careers.acme.example/careers/jobs/software-engineer-intern-123";
    const result = await resolveOfficialJobDestination(
      { employerCareerUrl: url },
      vi.fn(),
    );
    expect(result.officialApplicationUrl).toBe(url);
    expect(result.resolutionMethod).toBe("employer_career_site");
  });

  it.each([
    "https://www.linkedin.com/jobs/view/123",
    "https://www.indeed.com/viewjob?jk=123",
    "https://www.glassdoor.com/job-listing/123",
    "https://www.ziprecruiter.com/jobs/acme-123",
    "https://jobright.ai/jobs/info/123",
    "https://www.intern-list.com/listing/123",
    "https://simplify.jobs/p/123",
  ])("rejects aggregator detail URL %s as official", (url) => {
    expect(isValidOfficialApplicationUrl(url)).toBe(false);
  });

  it.each([
    "https://careers.acme.example/",
    "https://careers.acme.example/careers",
    "https://careers.acme.example/login",
    "https://careers.acme.example/jobs/search?q=intern",
  ])("rejects non-job employer page %s", async (url) => {
    const result = await resolveOfficialJobDestination(
      { officialApplicationUrl: url },
      vi.fn(async () => response(200)),
    );
    expect(result.resolutionStatus).toBe("OFFICIAL_URL_UNRESOLVED");
    expect(result.officialApplicationUrl).toBeNull();
  });

  it("rejects an unresolved aggregator", async () => {
    await expect(
      resolveOfficialApplicationDestination(
        { sourceUrl: "https://jobright.ai/jobs/info/missing" },
        vi.fn(async () => response(200, "<html></html>")),
      ),
    ).rejects.toBeInstanceOf(OfficialApplicationUrlUnresolvedError);
  });

  it("protects against redirect loops", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return response(
        302,
        "",
        url.includes("/a")
          ? "https://jobright.ai/jobs/info/b"
          : "https://jobright.ai/jobs/info/a",
      );
    });
    await expect(
      resolveOfficialApplicationDestination(
        { sourceUrl: "https://jobright.ai/jobs/info/a" },
        fetchMock,
      ),
    ).rejects.toBeInstanceOf(OfficialApplicationUrlUnresolvedError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records redirect-loop failure details without losing the source listing", async () => {
    const sourceListingUrl = "https://jobright.ai/jobs/info/a";
    const result = await resolveOfficialJobDestination(
      { sourceListingUrl },
      vi.fn(async (input: string | URL | Request) =>
        response(
          302,
          "",
          String(input).endsWith("/a")
            ? "https://jobright.ai/jobs/info/b"
            : "https://jobright.ai/jobs/info/a",
        ),
      ),
      new Date("2026-07-31T12:00:00.000Z"),
    );
    expect(result).toMatchObject({
      sourceListingUrl,
      officialApplicationUrl: null,
      resolutionStatus: "OFFICIAL_URL_UNRESOLVED",
      resolutionMethod: null,
      resolvedAt: "2026-07-31T12:00:00.000Z",
      resolutionError: "Destination redirect loop detected.",
    });
  });

  it("accepts only the validated final target of a safe redirect", async () => {
    const result = await resolveOfficialJobDestination(
      { officialApplyUrl: "https://tracking.acme.example/outbound/123" },
      vi.fn(async () =>
        response(302, "", "https://jobs.lever.co/acme/software-intern-123"),
      ),
    );
    expect(result).toMatchObject({
      officialApplicationUrl: "https://jobs.lever.co/acme/software-intern-123",
      resolutionStatus: "RESOLVED",
      resolutionMethod: "safe_redirect",
    });
  });

  it("persists canonical and audit fields while clearing an unresolved official URL", async () => {
    const unresolved = await resolveOfficialJobDestination(
      { sourceListingUrl: "https://jobright.ai/jobs/info/missing" },
      vi.fn(async () => response(200, "<html></html>")),
      new Date("2026-07-31T12:00:00.000Z"),
    );
    expect(destinationPersistenceData(unresolved)).toMatchObject({
      sourceListingUrl: "https://jobright.ai/jobs/info/missing",
      officialApplicationUrl: null,
      officialApplyUrl: null,
      url: null,
      resolutionStatus: "OFFICIAL_URL_UNRESOLVED",
      resolutionMethod: null,
      resolvedAt: new Date("2026-07-31T12:00:00.000Z"),
    });
    expect(unresolved.resolutionError).toBeTruthy();
  });

  it("marks a Jobright-only record unresolved without fetching it during ingestion", async () => {
    const fetchMock = vi.fn();
    const result = await resolveOfficialJobDestination(
      { sourceListingUrl: "https://jobright.ai/jobs/info/source-only" },
      fetchMock,
      new Date("2026-07-31T12:00:00.000Z"),
      { followSourceListings: false },
    );
    expect(result).toMatchObject({
      sourceListingUrl: "https://jobright.ai/jobs/info/source-only",
      officialApplicationUrl: null,
      resolutionStatus: "OFFICIAL_URL_UNRESOLVED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
