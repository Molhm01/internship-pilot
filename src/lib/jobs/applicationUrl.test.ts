import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSourceListingUrl,
  openStoredApplicationUrl,
  selectStoredApplicationLinks,
} from "./applicationUrl";

describe("stored application URL selection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens the resolved canonical official employer URL without any request", () => {
    const open = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(
      openStoredApplicationUrl(
        {
          resolutionStatus: "RESOLVED",
          officialApplicationUrl: "https://jobs.lever.co/acme/official",
          sourceListingUrl: "https://jobright.ai/jobs/info/123",
        },
        open,
      ),
    ).toBe(true);
    expect(open).toHaveBeenCalledWith(
      "https://jobs.lever.co/acme/official",
      "_blank",
      "noopener,noreferrer",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("opens canonical officialApplicationUrl only and preserves sourceListingUrl", () => {
    const open = vi.fn();
    const job = {
      resolutionStatus: "RESOLVED",
      sourceListingUrl: "https://jobright.ai/jobs/info/123",
      officialApplicationUrl: "https://jobs.ashbyhq.com/acme/official-123",
      officialApplyUrl: "https://jobright.ai/jobs/info/123",
      url: "https://www.intern-list.com/listing/123",
    };

    expect(selectStoredApplicationLinks(job)).toEqual({
      applicationUrl: "https://jobs.ashbyhq.com/acme/official-123",
      sourceListingUrl: "https://jobright.ai/jobs/info/123",
    });
    expect(openStoredApplicationUrl(job, open)).toBe(true);
    expect(open).toHaveBeenCalledWith(
      "https://jobs.ashbyhq.com/acme/official-123",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("does not promote an original job-post or redirect field into the canonical Apply destination", () => {
    expect(
      selectStoredApplicationLinks({
        redirectChain: JSON.stringify([
          { url: "https://careers.acme.com/jobs/1", status: 302 },
          { url: "https://acme.wd5.myworkdayjobs.com/en-US/jobs/job/1", status: 200 },
        ]),
        officialJobUrl: "https://careers.acme.com/jobs/1",
      }).applicationUrl,
    ).toBeNull();
  });

  it("does not promote a legacy redirect into the canonical Apply destination", () => {
    expect(
      selectStoredApplicationLinks({
        verificationStatus: "Pending",
        officialApplyUrl: "https://careers.acme.com/jobs/1",
        redirectChain: JSON.stringify([
          { url: "https://careers.acme.com/jobs/1", status: 302 },
          { url: "https://jobs.lever.co/acme/1", status: 200 },
        ]),
      }).applicationUrl,
    ).toBeNull();
  });

  it.each([
    "https://jobright.ai/jobs/info/1",
    "https://www.intern-list.com/listing/1",
    "https://simplify.jobs/p/1",
  ])("never treats %s as an Apply destination", (sourceUrl) => {
    const links = selectStoredApplicationLinks({
      sourceListingUrl: sourceUrl,
      officialApplicationUrl: sourceUrl,
      resolutionStatus: "RESOLVED",
    });
    expect(links.applicationUrl).toBeNull();
    expect(links.sourceListingUrl).toBe(sourceUrl);
    expect(isSourceListingUrl(sourceUrl)).toBe(true);
  });

  it("uses a direct ATS URL only after it is stored canonically as resolved", () => {
    expect(
      selectStoredApplicationLinks({
        resolutionStatus: "RESOLVED",
        officialApplicationUrl: "https://boards.greenhouse.io/acme/jobs/123",
      }),
    ).toEqual({
      applicationUrl: "https://boards.greenhouse.io/acme/jobs/123",
      sourceListingUrl: null,
    });
  });

  it("returns only the source-listing fallback when no official URL is stored", () => {
    expect(
      selectStoredApplicationLinks({
        sourceListingUrl: "https://jobright.ai/jobs/info/123",
        resolutionStatus: "OFFICIAL_URL_UNRESOLVED",
      }),
    ).toEqual({
      applicationUrl: null,
      sourceListingUrl: "https://jobright.ai/jobs/info/123",
    });
  });
});
