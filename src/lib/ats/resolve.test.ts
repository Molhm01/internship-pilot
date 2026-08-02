import { describe, expect, it } from "vitest";
import { boardNameMatchesCompany, candidateSlugs } from "@/lib/ats/resolve";

describe("candidateSlugs", () => {
  it("squashes a company name into the usual board-token form", () => {
    expect(candidateSlugs("Redwood Materials")).toContain("redwoodmaterials");
  });

  it("drops corporate suffixes that never appear in board tokens", () => {
    const slugs = candidateSlugs("Canopy Technologies, Inc.");
    expect(slugs).toContain("canopy");
    expect(slugs.every((s) => !s.includes("inc"))).toBe(true);
  });

  it("derives a slug from the website's apex label", () => {
    expect(candidateSlugs("Field AI", "https://www.fieldai.com")).toContain("fieldai");
  });

  it("offers a hyphenated variant alongside the squashed one", () => {
    const slugs = candidateSlugs("Scientific Research Corporation");
    expect(slugs).toContain("scientificresearch");
    expect(slugs).toContain("scientific-research");
  });

  it("expands ampersands rather than dropping the word", () => {
    expect(candidateSlugs("Langan Engineering & Environmental").join(" ")).toContain("and");
  });

  it("survives an unparseable website without throwing", () => {
    expect(() => candidateSlugs("Acme", "not a url")).not.toThrow();
    expect(candidateSlugs("Acme", "not a url")).toContain("acme");
  });

  it("never emits duplicate or trivially short slugs", () => {
    const slugs = candidateSlugs("Vast", "https://vast.space");
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.every((s) => s.length >= 3)).toBe(true);
  });

  it("REGRESSION: never emits a generic hostname label as a slug", () => {
    // "jobs.abbott.com" previously yielded the slug "jobs", which matched a
    // real but unrelated Ashby board.
    expect(candidateSlugs("Abbott", "https://jobs.abbott.com")).not.toContain("jobs");
    expect(candidateSlugs("Adient", "https://careers.adient.com")).not.toContain("careers");
  });

  it("REGRESSION: does not emit a short first-word prefix", () => {
    // "Air Products" previously yielded "air", colliding with an unrelated
    // Greenhouse board named "Air".
    expect(candidateSlugs("Air Products")).not.toContain("air");
  });

  it("still emits a long first-word prefix", () => {
    expect(candidateSlugs("Astranis Space Systems")).toContain("astranis");
  });
});

describe("boardNameMatchesCompany", () => {
  it("accepts an exact or near-complete name match", () => {
    expect(boardNameMatchesCompany("AST SpaceMobile", "AST SpaceMobile")).toBe(true);
    expect(boardNameMatchesCompany("Redwood Materials", "Redwood Materials Inc")).toBe(true);
  });

  it("REGRESSION: rejects a bare truncation of a longer company name", () => {
    expect(boardNameMatchesCompany("Air", "Air Products")).toBe(false);
  });

  it("REGRESSION: two companies sharing a leading word cannot claim one board", () => {
    // The aborted first sweep attributed the SAME greenhouse board "general"
    // to both of these employers.
    expect(boardNameMatchesCompany("General Motors", "General Atomics")).toBe(false);
    expect(boardNameMatchesCompany("General Atomics", "General Motors")).toBe(false);
    // The correct pairing still resolves.
    expect(boardNameMatchesCompany("General Atomics", "General Atomics")).toBe(true);
  });

  it("tolerates a corporate suffix on one side only", () => {
    expect(boardNameMatchesCompany("Redwood Materials", "Redwood Materials Inc")).toBe(true);
  });

  it("rejects an unrelated board", () => {
    expect(boardNameMatchesCompany("Acme Robotics", "Global Shipping")).toBe(false);
  });

  it("does not throw on empty names", () => {
    expect(boardNameMatchesCompany("", "Acme")).toBe(false);
    expect(boardNameMatchesCompany("Acme", "")).toBe(false);
  });
});
