import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { authEnvReport, emailAuthConfigured } from "./diagnostics";

const KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "DATABASE_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "VERCEL_PROJECT_PRODUCTION_URL", "NODE_ENV"] as const;

describe("authEnvReport — reports present/valid-shape, never values", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    const env = process.env as Record<string, string | undefined>;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
  });

  it("flags everything missing", () => {
    const r = authEnvReport();
    expect(r.BETTER_AUTH_SECRET.present).toBe(false);
    expect(r.DATABASE_URL.present).toBe(false);
    expect(emailAuthConfigured(r)).toBe(false);
  });

  it("accepts a well-shaped dev config", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    process.env.BETTER_AUTH_SECRET = "a".repeat(32);
    process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";
    const r = authEnvReport();
    expect(r.BETTER_AUTH_SECRET.validShape).toBe(true);
    expect(r.DATABASE_URL.validShape).toBe(true);
    expect(emailAuthConfigured(r)).toBe(true);
  });

  it("flags a SQLite DATABASE_URL as wrong shape", () => {
    process.env.DATABASE_URL = "file:./dev.db";
    expect(authEnvReport().DATABASE_URL.validShape).toBe(false);
  });

  it("in production, localhost base URL is invalid shape", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    const r = authEnvReport();
    expect(r.BETTER_AUTH_URL.validShape).toBe(false);
    expect(r.BETTER_AUTH_URL.note).toMatch(/localhost/i);
  });

  it("in production, an https production origin is valid", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.BETTER_AUTH_URL = "https://internship-pilot.vercel.app";
    process.env.BETTER_AUTH_SECRET = "a".repeat(32);
    process.env.DATABASE_URL = "postgresql://u:p@db.internal:5432/app";
    const r = authEnvReport();
    expect(r.BETTER_AUTH_URL.validShape).toBe(true);
    expect(emailAuthConfigured(r)).toBe(true);
  });

  it("report contains no secret values (only booleans + notes)", () => {
    process.env.BETTER_AUTH_SECRET = "SUPER-SECRET-VALUE-1234567890";
    process.env.DATABASE_URL = "postgres://user:HUNTER2@host/db";
    const serialized = JSON.stringify(authEnvReport());
    expect(serialized).not.toContain("SUPER-SECRET");
    expect(serialized).not.toContain("HUNTER2");
  });
});
