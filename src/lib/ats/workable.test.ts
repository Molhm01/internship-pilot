import { describe, expect, it } from "vitest";

import { parseWorkableJobs } from "@/lib/ats/workable";
import { detectAtsFromText } from "@/lib/ats/detect";

/**
 * Workable came out of the live miss dataset: two employers (Anthro Energy,
 * LV Collective) whose internships the pipeline could not reach at all. The
 * payload below is the real shape of the public widget response.
 */
const PAYLOAD = {
  name: "Anthro",
  jobs: [
    {
      title: "Manufacturing Engineering Intern",
      shortcode: "F08AA0CBF9",
      code: "REQ-42",
      employment_type: "Temporary",
      telecommuting: false,
      url: "https://apply.workable.com/j/F08AA0CBF9",
      shortlink: "https://apply.workable.com/j/F08AA0CBF9",
      application_url: "https://apply.workable.com/j/F08AA0CBF9/apply",
      published_on: "2026-08-20",
      created_at: "2026-08-18",
      country: "United States",
      city: "Alameda",
      state: "California",
      description: "<p>We are seeking a <strong>hands-on</strong> intern.</p><p>Second&nbsp;paragraph.</p>",
      locations: [{ country: "United States", city: "Alameda", region: "California", hidden: false }],
    },
    { title: "No shortcode", shortcode: "", url: "https://apply.workable.com/j/X" },
    { shortcode: "NOTITLE", url: "https://apply.workable.com/j/Y" },
  ],
};

describe("Workable public widget API", () => {
  it("normalizes a posting into the employer's own canonical apply URL", () => {
    const [job] = parseWorkableJobs(PAYLOAD, "anthro", "Anthro Energy");
    expect(job.applyUrl).toBe("https://apply.workable.com/j/F08AA0CBF9");
    expect(job.sourceJobId).toBe("F08AA0CBF9");
    expect(job.requisitionId).toBe("REQ-42");
    expect(job.company).toBe("Anthro Energy");
  });

  it("keeps the employer's real description as text, never synthesized", () => {
    const [job] = parseWorkableJobs(PAYLOAD, "anthro", "Anthro Energy");
    expect(job.description).toContain("hands-on");
    expect(job.description).toContain("Second paragraph");
    expect(job.description).not.toContain("<");
  });

  it("prefers the publication date over the creation date", () => {
    const [job] = parseWorkableJobs(PAYLOAD, "anthro", "Anthro Energy");
    expect(job.postedAt?.toISOString().slice(0, 10)).toBe("2026-08-20");
    expect(job.postedAtText).toBe("2026-08-20");
  });

  it("builds a comparable location string", () => {
    const [job] = parseWorkableJobs(PAYLOAD, "anthro", "Anthro Energy");
    expect(job.location).toBe("Alameda, California, United States");
  });

  it("drops rows that carry no shortcode or no title rather than inventing one", () => {
    expect(parseWorkableJobs(PAYLOAD, "anthro", "Anthro Energy")).toHaveLength(1);
  });

  it("returns nothing for a payload with no jobs array", () => {
    expect(parseWorkableJobs(null, "anthro", "Anthro")).toEqual([]);
    expect(parseWorkableJobs({}, "anthro", "Anthro")).toEqual([]);
    expect(parseWorkableJobs({ jobs: [] }, "anthro", "Anthro")).toEqual([]);
  });
});

describe("Workable tenant detection", () => {
  it("reads the ACCOUNT from a careers page link", () => {
    expect(detectAtsFromText('<a href="https://apply.workable.com/anthro/">Open roles</a>')).toEqual({
      atsType: "workable",
      atsIdentifier: "anthro",
    });
  });

  it("REGRESSION: never reads a posting link's /j/ segment as the tenant", () => {
    // apply.workable.com/j/<shortcode> is a JOB, not an account. Storing "j"
    // as the tenant would configure every Workable employer identically.
    const detected = detectAtsFromText('<a href="https://apply.workable.com/j/F08AA0CBF9">Apply</a>');
    expect(detected.atsIdentifier).not.toBe("j");
    expect(detected.atsType).not.toBe("workable");
  });
});
