import { describe, expect, it, vi } from "vitest";

const getSessionCookie = vi.fn();
vi.mock("better-auth/cookies", () => ({ getSessionCookie: (...args: unknown[]) => getSessionCookie(...args) }));

import { proxy } from "./proxy";
import type { NextRequest } from "next/server";

/**
 * What the route proxy lets past without a session cookie.
 *
 * The proxy is not the authorization layer — every private route authenticates
 * again on the server — but it is in front of everything, so a route it refuses
 * never gets the chance. Two kinds of route carry their own credential and must
 * therefore be allowed to check it themselves: the browser extension's
 * token-authenticated endpoints, and the cron handlers.
 */
function request(pathname: string): NextRequest {
  const url = new URL(`http://127.0.0.1:3000${pathname}`);
  return { nextUrl: url, url: url.toString(), headers: new Headers() } as unknown as NextRequest;
}

describe("route proxy", () => {
  it("lets the extension's token-authenticated routes reach their own auth check", () => {
    // The extension sends `Authorization: Bearer <token>`, never a cookie. A
    // 401 here means the agent cannot work at all in a browser profile that is
    // not separately signed in to this origin.
    getSessionCookie.mockReturnValue(null);

    for (const path of [
      "/api/extension/health",
      "/api/extension/profile",
      "/api/extension/fill-plan",
      "/api/extension/approved-answers",
      "/api/extension/report",
      "/api/extension/runs/run-1",
      "/api/extension/documents/doc-1",
    ]) {
      const response = proxy(request(path));
      expect(response.status, `${path} must not be refused by the proxy`).not.toBe(401);
    }
  });

  it("lets autonomous workspace pages and APIs through without forcing sign-in by default", () => {
    delete process.env.REQUIRE_AUTH;
    getSessionCookie.mockReturnValue(null);

    expect(proxy(request("/dashboard")).status).toBe(200);
    for (const path of ["/api/jobs", "/api/documents", "/api/applications/run-1", "/api/profile"]) {
      expect(proxy(request(path)).status, `${path} must open in workspace mode`).toBe(200);
    }
  });

  it("keeps extension token issuance, private APIs, and workspace redirects enforced when REQUIRE_AUTH=true", () => {
    process.env.REQUIRE_AUTH = "true";
    try {
      getSessionCookie.mockReturnValue(null);

      expect(proxy(request("/api/health")).status).toBe(200);
      expect(proxy(request("/api/extension/tokens")).status).toBe(401);
      for (const path of ["/api/jobs", "/api/documents", "/api/applications/run-1", "/api/profile"]) {
        expect(proxy(request(path)).status, `${path} must require a session`).toBe(401);
      }

      const response = proxy(request("/dashboard"));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain("/login");
    } finally {
      delete process.env.REQUIRE_AUTH;
    }
  });

  it("lets a signed-in request through", () => {
    getSessionCookie.mockReturnValue("session-token");

    expect(proxy(request("/api/jobs")).status).toBe(200);
  });
});
