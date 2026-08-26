import { describe, expect, it } from "vitest";
import { isCanonicalInstanceUrl } from "./localStartup";

describe("isCanonicalInstanceUrl", () => {
  const canonical = { host: "127.0.0.1", port: 51225 };

  it("flags a differently-named database on the same host:port as the canonical instance", () => {
    // The exact trap this guard exists to close: a local Prisma Dev instance
    // serves one database regardless of the name in the connection URL.
    expect(isCanonicalInstanceUrl("postgres://postgres:postgres@localhost:51225/internship_pilot_test?sslmode=disable", canonical)).toBe(true);
    expect(isCanonicalInstanceUrl("postgres://postgres:postgres@127.0.0.1:51225/audit_db", canonical)).toBe(true);
  });

  it("treats localhost and 127.0.0.1 as the same host", () => {
    expect(isCanonicalInstanceUrl("postgres://postgres:postgres@localhost:51225/template1", canonical)).toBe(true);
  });

  it("does not flag a genuinely separate instance (different port)", () => {
    expect(isCanonicalInstanceUrl("postgres://postgres:postgres@localhost:51230/internship_pilot_audit?sslmode=disable", canonical)).toBe(false);
  });

  it("does not flag an unrelated host", () => {
    expect(isCanonicalInstanceUrl("postgres://postgres:postgres@db.example.com:5432/ci_test", canonical)).toBe(false);
  });

  it("treats an unparseable URL as not canonical rather than throwing", () => {
    expect(isCanonicalInstanceUrl("not-a-url", canonical)).toBe(false);
  });
});
