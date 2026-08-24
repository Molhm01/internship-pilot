import { describe, expect, it } from "vitest";

import { detectAtsFromText } from "@/lib/ats/detect";
import {
  parseOracleRecruitingCloudIdentifier,
  parseOracleRecruitingCloudJobs,
  oracleRecruitingCloudBoardName,
} from "@/lib/ats/oracleRecruitingCloud";

const TENANT = { host: "egug.fa.us2.oraclecloud.com", locale: "en", siteNumber: "CX_1" };
const PAYLOAD = {
  items: [
    {
      TotalJobsCount: 403,
      requisitionList: [
        {
          Id: "26012375",
          Title: "AI Engineer Intern - Enterprise Technology Services",
          PostedDate: "2026-08-23",
          PrimaryLocation: "New York, NY, United States",
          WorkplaceType: "Hybrid",
          ShortDescriptionStr: "Build employer AI systems.",
          ExternalQualificationsStr: "Currently pursuing an engineering degree.",
        },
        { Id: "26012412", Title: "Senior Product Manager, Internal Tools" },
        { Id: "26005240", Title: "Manager-Operations Risk Management" },
      ],
    },
  ],
};

describe("Oracle Recruiting Cloud public search", () => {
  it("carries the observed host, locale and site number as one tenant identity", () => {
    expect(parseOracleRecruitingCloudIdentifier("egug.fa.us2.oraclecloud.com|en|CX_1")).toEqual(TENANT);
    expect(parseOracleRecruitingCloudIdentifier("host only")).toBeNull();
    expect(parseOracleRecruitingCloudIdentifier("bad host|en|CX_1")).toBeNull();
  });

  it("maps internship rows and keeps the official Candidate Experience job URL", () => {
    const jobs = parseOracleRecruitingCloudJobs(PAYLOAD, TENANT, "American Express");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      sourceJobId: "26012375",
      requisitionId: "26012375",
      title: "AI Engineer Intern - Enterprise Technology Services",
      company: "American Express",
      location: "New York, NY, United States",
      workplaceType: "Hybrid",
      applyUrl:
        "https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26012375",
      postedAtText: "2026-08-23",
    });
    expect(jobs[0]!.postedAt?.toISOString()).toBe("2026-08-23T00:00:00.000Z");
    expect(jobs[0]!.description).toContain("employer AI systems");
    expect(jobs[0]!.description).toContain("engineering degree");
  });

  it("routes an employer-published Candidate Experience URL without guessing a tenant", () => {
    expect(
      detectAtsFromText(
        "https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs",
      ),
    ).toEqual({
      atsType: "oracle-recruiting-cloud",
      atsIdentifier: "egug.fa.us2.oraclecloud.com|en|CX_1",
    });
  });

  it("reads the employer brand used to guard board identity", () => {
    expect(oracleRecruitingCloudBoardName("<title>American Express Careers</title>")).toBe(
      "American Express Careers",
    );
    expect(oracleRecruitingCloudBoardName("<html><body>no title</body></html>")).toBeNull();
  });
});
