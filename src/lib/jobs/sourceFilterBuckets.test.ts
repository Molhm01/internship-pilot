import { describe, expect, it } from "vitest";
import { sourcesForBucket } from "./sourceFilterBuckets";

describe("sourcesForBucket", () => {
  it("returns null for an empty/absent bucket (no filter applied)", () => {
    expect(sourcesForBucket(null)).toBeNull();
    expect(sourcesForBucket(undefined)).toBeNull();
    expect(sourcesForBucket("")).toBeNull();
  });

  it("maps official_ats to the direct-official ATS tokens", () => {
    const sources = sourcesForBucket("official_ats");
    expect(sources).toContain("greenhouse");
    expect(sources).toContain("lever");
    expect(sources).toContain("workday");
    expect(sources).not.toContain("manual");
    expect(sources).not.toContain("intern-list");
  });

  it("maps intern_list to intern-list raw source tokens", () => {
    expect(sourcesForBucket("intern_list")).toEqual(["intern-list", "intern-list-public"]);
  });

  it("maps aggregator to jobright/simplify tokens, never a direct-official source", () => {
    const sources = sourcesForBucket("aggregator");
    expect(sources).toContain("jobright");
    expect(sources).toContain("simplify");
    expect(sources).not.toContain("greenhouse");
  });

  it("maps manual and other to their exact single token", () => {
    expect(sourcesForBucket("manual")).toEqual(["manual"]);
    expect(sourcesForBucket("other")).toEqual(["other"]);
  });

  it("returns null for an unrecognized bucket key", () => {
    expect(sourcesForBucket("not-a-real-bucket")).toBeNull();
  });
});
