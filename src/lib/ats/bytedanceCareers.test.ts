import { describe, expect, it } from "vitest";

import {
  flattenLocation,
  parseByteDanceJobs,
  parseByteDanceTenant,
} from "@/lib/ats/bytedanceCareers";
import { detectAtsFromText } from "@/lib/ats/detect";

/**
 * The ByteDance-family public search, whose contract was observed from the
 * employers' own pages. The payload is the real response shape.
 */
const TENANT = { apiHost: "api.lifeattiktok.com", websitePath: "tiktok", siteHost: "lifeattiktok.com" };

const PAYLOAD = {
  code: 0,
  data: {
    count: 1105,
    job_post_list: [
      {
        id: "7660367862386673925",
        code: "A208284",
        title: "Algorithm Engineer Intern (TikTok Live Revenue) - 2027 Start (PhD)",
        description: "TikTok LIVE Revenue team.",
        requirement: "Minimum Qualifications\n- Pursuing a PhD.",
        recruit_type: { en_name: "Intern" },
        city_info: {
          en_name: "San Jose",
          parent: { en_name: "California", parent: { en_name: "United States", parent: null } },
        },
      },
      { id: "", title: "No id" },
      { id: "123", title: "" },
    ],
  },
};

describe("ByteDance-family public careers search", () => {
  it("uses the employer's own posting page as the canonical apply URL", () => {
    const [job] = parseByteDanceJobs(PAYLOAD, TENANT, "TikTok");
    expect(job.applyUrl).toBe("https://lifeattiktok.com/search/7660367862386673925");
    expect(job.sourceJobId).toBe("7660367862386673925");
    expect(job.requisitionId).toBe("A208284");
  });

  it("flattens the nested city → state → country into a comparable location", () => {
    const [job] = parseByteDanceJobs(PAYLOAD, TENANT, "TikTok");
    expect(job.location).toBe("San Jose, California, United States");
    expect(flattenLocation(null)).toBeNull();
    expect(flattenLocation({ en_name: "Singapore" })).toBe("Singapore");
  });

  it("keeps the employer's own description AND requirements as the JD", () => {
    const [job] = parseByteDanceJobs(PAYLOAD, TENANT, "TikTok");
    expect(job.description).toContain("TikTok LIVE Revenue team.");
    expect(job.description).toContain("Pursuing a PhD.");
  });

  it("records NO posting date rather than inventing one", () => {
    const [job] = parseByteDanceJobs(PAYLOAD, TENANT, "TikTok");
    expect(job.postedAt).toBeNull();
    expect(job.postedAtText).toBeNull();
  });

  it("drops rows with no id or no title", () => {
    expect(parseByteDanceJobs(PAYLOAD, TENANT, "TikTok")).toHaveLength(1);
  });

  it("returns nothing for a malformed payload", () => {
    expect(parseByteDanceJobs(null, TENANT, "TikTok")).toEqual([]);
    expect(parseByteDanceJobs({ code: 0 }, TENANT, "TikTok")).toEqual([]);
  });
});

describe("ByteDance-family tenant identity", () => {
  it("carries the API host, brand routing value and site host together", () => {
    expect(parseByteDanceTenant("jobs.bytedance.com|en|joinbytedance.com")).toEqual({
      apiHost: "jobs.bytedance.com",
      websitePath: "en",
      siteHost: "joinbytedance.com",
    });
  });

  it("refuses an identifier that does not name all three, so no host is guessed", () => {
    expect(parseByteDanceTenant("tiktok")).toBeNull();
    expect(parseByteDanceTenant("a|b")).toBeNull();
    expect(parseByteDanceTenant("bad host|b|c")).toBeNull();
  });

  it("routes each brand from its own careers host", () => {
    expect(detectAtsFromText("https://lifeattiktok.com/search?keyword=intern")).toEqual({
      atsType: "bytedance-careers",
      atsIdentifier: "api.lifeattiktok.com|tiktok|lifeattiktok.com",
    });
    expect(detectAtsFromText("https://jobs.bytedance.com/en/position").atsIdentifier).toBe(
      "jobs.bytedance.com|en|joinbytedance.com",
    );
  });
});
