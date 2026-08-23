import { describe, expect, it } from "vitest";
import {
  OFFICIAL_BOARD_MATCH_THRESHOLD,
  scoreOfficialBoardMatch,
  stateCode,
} from "@/lib/sync/officialBoardMatch";

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

describe("title matching against real board title padding", () => {
  it("accepts a board title that only ADDS team/location qualifiers", () => {
    // Boards append qualifiers a feed omits. "Structural Engineering
    // Internship" and "Structural Engineering Intern - Bridge Group - Chicago"
    // are one posting, and dividing overlap by the longer title alone scored
    // that pairing below the accept bar.
    const score = scoreOfficialBoardMatch(
      { title: "Bridge Structural Engineering Internship", location: "Chicago, IL" },
      {
        title: "Bridge Structural Engineering Intern - Transportation Group",
        location: "Chicago, IL",
        applyUrl: "https://boards.greenhouse.io/benesch/jobs/9001",
      },
    );
    expect(score).toBeGreaterThanOrEqual(OFFICIAL_BOARD_MATCH_THRESHOLD);
  });

  it("does not let a short generic title absorb a longer unrelated one", () => {
    // Only two distinctive tokens, so containment earns no lift — otherwise an
    // internship could match a manager role that merely mentions interns.
    const score = scoreOfficialBoardMatch(
      { title: "Software Intern", location: "Austin, TX" },
      {
        title: "Software Intern Program Manager Talent Operations",
        location: "Austin, TX",
        applyUrl: "https://boards.greenhouse.io/acme/jobs/1",
      },
    );
    expect(score).toBeLessThan(OFFICIAL_BOARD_MATCH_THRESHOLD);
  });

  it("REGRESSION: never matches an internship to the full-time role of the same name", () => {
    const score = scoreOfficialBoardMatch(
      { title: "Formal Verification Engineering Intern", location: "Austin, TX" },
      {
        title: "Formal Verification Engineering Engineer",
        location: "Austin, TX",
        applyUrl: "https://boards.greenhouse.io/tenstorrent/jobs/1",
      },
    );
    expect(score).toBe(0);
  });
});

describe("US state resolution", () => {
  it("REGRESSION: does not read 'United States of America' as the state 'OF'", () => {
    // A case-insensitive [A-Z]{2} matched the word "of", which then conflicted
    // with the signal's real state and rejected an exact-title match on the
    // employer's own board.
    expect(stateCode("Mason, Ohio, United States of America")).toBe("OH");
  });

  it("resolves spelled-out state names so differing formats can be compared", () => {
    expect(stateCode("Cincinnati, OH")).toBe("OH");
    expect(stateCode("Boise, Idaho - Main Site")).toBe("ID");
    expect(stateCode("New York, New York, United States")).toBe("NY");
  });

  it("returns null rather than guessing when there is no US state", () => {
    expect(stateCode("Singapore, Singapore")).toBeNull();
    expect(stateCode("Remote")).toBeNull();
    expect(stateCode(null)).toBeNull();
  });

  it("matches an exact title across differing location formats", () => {
    const score = scoreOfficialBoardMatch(
      { title: "University of Cincinnati R&D Engineer Co-op", location: "Cincinnati, OH" },
      {
        title: "University of Cincinnati R&D Engineer Co-op",
        location: "Mason, Ohio, United States of America",
        applyUrl: "https://pg.wd5.myworkdayjobs.com/1000/job/Mason/Co-op_R000155207",
      },
    );
    expect(score).toBeGreaterThanOrEqual(OFFICIAL_BOARD_MATCH_THRESHOLD);
  });
});
