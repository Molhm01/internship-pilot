import { afterEach, describe, expect, it } from "vitest";
import { AppUrlNotConfiguredError, absoluteAppUrl, appUrl, resolveAppUrl } from "./appUrl";

/**
 * The canonical application URL.
 *
 * This value leaves the process: it becomes `metadataBase` for every Open
 * Graph image and the redirect URI Google is asked to send the user back to.
 * Hard-coded to localhost it pointed both at whoever happened to be viewing
 * the page, so the important behaviour here is that a deployment never
 * silently inherits a development default.
 */

const KEYS = [
  "NEXT_PUBLIC_APP_URL",
  "VERCEL",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "INTERNSHIP_PILOT_RUNTIME",
  "NODE_ENV",
] as const;

const SAVED = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

function clear() {
  for (const key of KEYS) delete process.env[key];
}

/**
 * `NODE_ENV` is typed read-only, but the point of these tests is what the
 * resolver does in each build mode, so it has to be set.
 */
const env = process.env as Record<string, string | undefined>;

afterEach(() => {
  clear();
  for (const [key, value] of Object.entries(SAVED)) {
    if (value !== undefined) process.env[key] = value;
  }
});

describe("resolving the canonical app URL", () => {
  it("prefers the explicitly configured origin", () => {
    clear();
    process.env.NEXT_PUBLIC_APP_URL = "https://internship-pilot.example/";

    expect(resolveAppUrl()).toBe("https://internship-pilot.example");
  });

  it("accepts a bare hostname and assumes HTTPS", () => {
    clear();
    process.env.NEXT_PUBLIC_APP_URL = "internship-pilot.vercel.app";

    expect(resolveAppUrl()).toBe("https://internship-pilot.vercel.app");
  });

  it("falls back to the stable production hostname over the per-deployment one", () => {
    clear();
    process.env.VERCEL = "1";
    process.env.VERCEL_URL = "internship-pilot-abc123.vercel.app";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "internship-pilot.vercel.app";

    // A preview build must not advertise a URL that stops resolving on the
    // next deployment.
    expect(resolveAppUrl()).toBe("https://internship-pilot.vercel.app");
  });

  it("uses localhost in development", () => {
    clear();
    env.NODE_ENV = "development";

    expect(resolveAppUrl()).toBe("http://localhost:3000");
  });

  it("never invents localhost for a cloud runtime", () => {
    clear();
    process.env.INTERNSHIP_PILOT_RUNTIME = "cloud";

    expect(resolveAppUrl()).toBeNull();
    expect(() => appUrl()).toThrow(AppUrlNotConfiguredError);
  });

  it("never invents localhost for a production build", () => {
    clear();
    env.NODE_ENV = "production";

    expect(resolveAppUrl()).toBeNull();
  });
});

describe("absolute URLs built from it", () => {
  it("produces the OAuth callback against the configured origin", () => {
    clear();
    process.env.NEXT_PUBLIC_APP_URL = "https://internship-pilot.example";

    expect(absoluteAppUrl("/api/gmail/auth/callback")).toBe(
      "https://internship-pilot.example/api/gmail/auth/callback",
    );
  });

  it("does not leak localhost into a deployed callback", () => {
    clear();
    process.env.VERCEL = "1";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "internship-pilot.vercel.app";

    expect(absoluteAppUrl("/api/gmail/auth/callback")).not.toContain("localhost");
  });
});
