import { describe, expect, it } from "vitest";

import { careersHostUrls, hostCandidates, slugLooksLikeEmployer } from "@/lib/sync/employerBoardResolution";

/**
 * Two fixes that came straight out of the live miss dataset (60 fresh signals,
 * 2026-08-23): the careers HOST the cascade never tried, and the board it
 * configured for the wrong employer.
 */

describe("the employer's own careers host", () => {
  it("offers careers.<domain> and jobs.<domain>, which is where large employers put the vendor", () => {
    // Measured: careers.newyorklife.com serves SuccessFactors, jobs.grainger.com
    // serves SuccessFactors, careers.mayoclinic.org serves Eightfold — and all
    // three were recorded as NO_ATS_CONFIG because only paths were tried.
    expect(careersHostUrls("newyorklife.com")).toEqual([
      "https://careers.newyorklife.com/",
      "https://jobs.newyorklife.com/",
    ]);
    expect(careersHostUrls("grainger.com")).toContain("https://jobs.grainger.com/");
    expect(careersHostUrls("mayoclinic.org")).toContain("https://careers.mayoclinic.org/");
  });

  it("also covers the apex when the source published a regional host", () => {
    const urls = careersHostUrls("usa.philips.com");
    expect(urls).toContain("https://careers.philips.com/");
    expect(urls).toContain("https://careers.usa.philips.com/");
  });

  it("never stacks a careers prefix onto a host that already carries one", () => {
    // careers.gf.com has no separate apex candidate (two-letter second label),
    // so there is nothing left to prefix and the pass is a no-op.
    expect(careersHostUrls("careers.gf.com")).toEqual([]);
    // jobs.apple.com DOES yield the apex, so careers.apple.com is still worth
    // trying — but "careers.jobs.apple.com" must never be constructed.
    const urls = careersHostUrls("jobs.apple.com");
    expect(urls).toContain("https://careers.apple.com/");
    expect(urls.some((url) => /careers\.jobs\.|jobs\.jobs\./.test(url))).toBe(false);
  });

  it("stays bounded — two hosts per candidate, root only, never a path sweep", () => {
    for (const domain of ["example.com", "usa.example.com", "sub.example.co.uk"]) {
      const urls = careersHostUrls(domain);
      expect(urls.length).toBeLessThanOrEqual(2 * hostCandidates(domain).length);
      for (const url of urls) expect(new URL(url).pathname).toBe("/");
    }
  });
});

describe("a board must belong to the employer it is configured for", () => {
  it("REGRESSION: rejects True Anomaly's Greenhouse board for Cubit Capital", () => {
    // Measured: cubit.capital's careers page links to boards.greenhouse.io/
    // trueanomalyinc, and the pipeline cached that as Cubit Capital's board.
    // Nothing false was published only because the title matcher happened to
    // reject every posting on it.
    expect(slugLooksLikeEmployer("trueanomalyinc", "Cubit Capital", "cubit.capital")).toBe(false);
  });

  it("accepts the ordinary cases, so no correct configuration is lost", () => {
    expect(slugLooksLikeEmployer("tenstorrent", "Tenstorrent", "tenstorrent.com")).toBe(true);
    expect(slugLooksLikeEmployer("rocketlabusa", "Rocket Lab", "rocketlabusa.com")).toBe(true);
    expect(slugLooksLikeEmployer("blueorigin", "Blue Origin", "blueorigin.com")).toBe(true);
    // Slug shorter than the company name.
    expect(slugLooksLikeEmployer("anduril", "Anduril Industries", "anduril.com")).toBe(true);
    // Agreement via the domain when the display name differs.
    expect(slugLooksLikeEmployer("globalfoundries", "GF", "globalfoundries.com")).toBe(true);
  });

  it("ignores punctuation and case differences between name and slug", () => {
    expect(slugLooksLikeEmployer("kimley-horn", "Kimley-Horn", "kimley-horn.com")).toBe(true);
    expect(slugLooksLikeEmployer("WalterPMoore", "Walter P Moore", "walterpmoore.com")).toBe(true);
  });

  it("does not accept a short unrelated slug through a stray substring", () => {
    expect(slugLooksLikeEmployer("acme", "Zephyr Dynamics", "zephyrdynamics.com")).toBe(false);
    expect(slugLooksLikeEmployer("stripe", "Block", "block.xyz")).toBe(false);
  });
});
