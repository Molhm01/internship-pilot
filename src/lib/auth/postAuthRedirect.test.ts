import { describe, expect, it } from "vitest";
import { safeNextPath } from "./postAuthRedirect";

describe("safeNextPath", () => {
  it("defaults to /dashboard when next is absent", () => {
    expect(safeNextPath(null)).toBe("/dashboard");
    expect(safeNextPath(undefined)).toBe("/dashboard");
    expect(safeNextPath("")).toBe("/dashboard");
  });

  it("accepts a same-origin path", () => {
    expect(safeNextPath("/jobs")).toBe("/jobs");
    expect(safeNextPath("/jobs/abc123")).toBe("/jobs/abc123");
  });

  it("rejects a protocol-relative URL (open-redirect attempt)", () => {
    expect(safeNextPath("//evil.example.com")).toBe("/dashboard");
  });

  it("rejects an absolute URL", () => {
    expect(safeNextPath("https://evil.example.com")).toBe("/dashboard");
    expect(safeNextPath("http://evil.example.com/jobs")).toBe("/dashboard");
  });

  it("rejects a path with no leading slash", () => {
    expect(safeNextPath("jobs")).toBe("/dashboard");
  });
});
