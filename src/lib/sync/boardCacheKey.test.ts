import { describe, expect, it } from "vitest";

import { boardCacheKey } from "@/lib/sync/jobrightFreshDiscovery";

/**
 * The per-tick board cache exists so one employer's board is crawled once per
 * radar tick instead of once per posting. Its key must therefore identify an
 * EMPLOYER's board — not a vendor.
 *
 * The original key was `${atsType}:${atsIdentifier}`, and atsIdentifier is null
 * for every `custom`/`unknown` employer. A live 60-signal run showed three
 * unrelated employers — Armstrong World Industries, Newport News Shipbuilding
 * and CMC — all receiving the same three postings, because all three hashed to
 * "custom:null" and the first result was reused for the rest. That can publish
 * one company's posting under another company's name.
 */
describe("board cache identity", () => {
  it("REGRESSION: unconfigured employers never share one cache entry", () => {
    const armstrong = boardCacheKey({
      atsType: "custom",
      atsIdentifier: null,
      careersUrl: "https://www.armstrongceilings.com/careers",
      name: "Armstrong World Industries",
    });
    const newportNews = boardCacheKey({
      atsType: "custom",
      atsIdentifier: null,
      careersUrl: "https://careers.hii.com/",
      name: "Newport News Shipbuilding",
    });
    const cmc = boardCacheKey({
      atsType: "custom",
      atsIdentifier: null,
      careersUrl: null,
      name: "CMC",
    });

    expect(new Set([armstrong, newportNews, cmc]).size).toBe(3);
    expect(armstrong).not.toContain("null");
  });

  it("still collapses repeated reads of the SAME employer board", () => {
    const first = boardCacheKey({
      atsType: "greenhouse",
      atsIdentifier: "tenstorrent",
      careersUrl: "https://tenstorrent.com/careers",
      name: "Tenstorrent",
    });
    const second = boardCacheKey({
      atsType: "greenhouse",
      atsIdentifier: "tenstorrent",
      careersUrl: "https://job-boards.greenhouse.io/tenstorrent",
      name: "Tenstorrent Inc",
    });
    expect(first).toBe(second);
  });

  it("separates two employers on the same vendor", () => {
    expect(boardCacheKey({ atsType: "workday", atsIdentifier: "amd.wd1/External" })).not.toBe(
      boardCacheKey({ atsType: "workday", atsIdentifier: "flir.wd1/flircareers" }),
    );
  });

  it("never produces the same key for different vendors", () => {
    expect(boardCacheKey({ atsType: "icims", atsIdentifier: "acme" })).not.toBe(
      boardCacheKey({ atsType: "greenhouse", atsIdentifier: "acme" }),
    );
  });

  it("falls back to a stable label when nothing identifies the employer", () => {
    const key = boardCacheKey({ atsType: null, atsIdentifier: null });
    expect(key).toBe("unknown:unidentified");
  });
});
