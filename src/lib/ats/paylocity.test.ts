import { describe, expect, it } from "vitest";

import { detectAtsFromText } from "@/lib/ats/detect";
import { parsePaylocityIdentifier, parsePaylocityJobs } from "@/lib/ats/paylocity";

const COMPANY_ID = "dcf96dd8-75af-49cc-8b4a-d86e13175def";

function pageDataHtml(): string {
  return `<script>
    window.pageData = ${JSON.stringify({
      Jobs: [
        {
          JobId: 3605888,
          JobTitle: "Engineering Intern",
          LocationName: "Texas",
          PublishedDate: "2025-09-26T15:02:51-05:00",
          Description: "Internship based in Houston and College Station.",
          IsRemote: false,
        },
        { JobId: 1, JobTitle: "Senior Project Manager" },
      ],
    })};
  </script>`;
}

describe("Paylocity public recruiting board", () => {
  it("keeps the employer-published company id and slug together", () => {
    expect(parsePaylocityIdentifier(`${COMPANY_ID}|DCCM`)).toEqual({
      companyId: COMPANY_ID,
      slug: "DCCM",
    });
    expect(parsePaylocityIdentifier("DCCM")).toBeNull();
    expect(parsePaylocityIdentifier("not-a-guid|DCCM")).toBeNull();
  });

  it("maps embedded pageData jobs to canonical Paylocity detail URLs", () => {
    const jobs = parsePaylocityJobs(pageDataHtml(), "DCCM");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      sourceJobId: "3605888",
      requisitionId: "3605888",
      title: "Engineering Intern",
      company: "DCCM",
      location: "Texas",
      applyUrl: "https://recruiting.paylocity.com/Recruiting/Jobs/Details/3605888",
      description: "Internship based in Houston and College Station.",
      postedAtText: "2025-09-26T15:02:51-05:00",
    });
  });

  it("detects only a complete employer-published Paylocity board URL", () => {
    expect(
      detectAtsFromText(
        `https://recruiting.paylocity.com/recruiting/jobs/All/${COMPANY_ID}/DCCM`,
      ),
    ).toEqual({
      atsType: "paylocity",
      atsIdentifier: `${COMPANY_ID}|DCCM`,
    });
    expect(
      detectAtsFromText("https://recruiting.paylocity.com/Recruiting/Jobs/Details/3605888").atsType,
    ).toBe("unknown");
  });
});
