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

  it("keeps extension token issuance behind the session", () => {
    // Minting and revoking extension tokens is a session action from Settings.
    // Nothing holding only an extension token should be able to issue more.
    getSessionCookie.mockReturnValue(null);

    expect(proxy(request("/api/extension/tokens")).status).toBe(401);
  });

  it("lets the local launcher read this server's instance identity", () => {
    // `npm run local` asks this before any account exists — and specifically
    // when the process on the port may be a stale build it needs to restart.
    // Behind a session it could never answer, and the launcher would be back
    // to trusting an HTTP 200. The route itself refuses in a cloud runtime.
    getSessionCookie.mockReturnValue(null);

    expect(proxy(request("/api/local/instance")).status).not.toBe(401);
  });

  it("lets every hosted ingestion lane reach its own CRON_SECRET check", () => {
    getSessionCookie.mockReturnValue(null);

    for (const path of [
      "/api/cron/job-ingestion",
      "/api/cron/job-ingestion/fresh",
      "/api/cron/job-ingestion/standard",
      "/api/cron/job-ingestion/maintenance",
    ]) {
      expect(proxy(request(path)).status, `${path} must reach its own auth check`).not.toBe(401);
    }
  });

  it("still refuses every other private API route without a session", () => {
    getSessionCookie.mockReturnValue(null);

    for (const path of ["/api/jobs", "/api/documents", "/api/applications/run-1", "/api/profile"]) {
      expect(proxy(request(path)).status, `${path} must require a session`).toBe(401);
    }
  });

  it("redirects a signed-out visitor away from a workspace page", () => {
    getSessionCookie.mockReturnValue(null);

    const response = proxy(request("/dashboard"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });

  it("lets a signed-in request through", () => {
    getSessionCookie.mockReturnValue("session-token");

    expect(proxy(request("/api/jobs")).status).toBe(200);
  });
});
