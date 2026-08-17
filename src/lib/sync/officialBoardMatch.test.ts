import { describe, expect, it } from "vitest";
import { scoreOfficialBoardMatch } from "@/lib/sync/officialBoardMatch";

describe("official employer board matching", () => {
  it("strongly matches the same internship with cosmetic title differences", () => {
    const score = scoreOfficialBoardMatch(
      { title: "Mechanical Engineering Intern - Fall 2026", location: "Long Beach, CA" },
      {
        title: "Mechanical Engineering Intern Fall 2026",
        location: "Long Beach, CA",
        applyUrl: "https://boards.greenhouse.io/rocketlab/jobs/123",
      },
    );
    expect(score).toBeGreaterThanOrEqual(0.9);
  });

  it("rejects a same-title posting in a conflicting state", () => {
    const score = scoreOfficialBoardMatch(
      { title: "Electrical Engineering Intern", location: "Boston, MA" },
      {
        title: "Electrical Engineering Intern",
        location: "Austin, TX",
        applyUrl: "https://jobs.lever.co/acme/123",
      },
    );
    expect(score).toBe(0);
  });

  it("never treats an aggregator URL as the employer match", () => {
    const score = scoreOfficialBoardMatch(
      { title: "Hardware Engineering Intern", location: "New York, NY" },
      {
        title: "Hardware Engineering Intern",
        location: "New York, NY",
        applyUrl: "https://jobright.ai/jobs/info/123",
      },
    );
    expect(score).toBe(0);
  });
});
