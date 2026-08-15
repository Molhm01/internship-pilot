import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const findUniqueMock = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    appSetting: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
    },
  },
}));

const ORIGINAL_ENV = { ...process.env };

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    company: "Acme Robotics",
    jobTitle: "Software Engineering Intern",
    url: "https://boards.greenhouse.io/acme/jobs/12345",
    location: "Boston, MA",
    eligibilityScore: 0.65,
    tailoredResumeDocumentId: "doc-resume-1",
    tailoredCoverLetterDocumentId: "doc-cover-1",
    startAutofill: false,
    ...overrides,
  };
}

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:3000/api/application-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/application-sessions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.INTERNSHIP_AGENT_TOKEN;
    delete process.env.INTERNSHIP_AGENT_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it("returns 200 and the session id when the configured token is valid (downstream 200)", async () => {
    process.env.INTERNSHIP_AGENT_TOKEN = "correct-token-0123456789abcdef";
    process.env.INTERNSHIP_AGENT_BASE_URL = "http://127.0.0.1:4317";

    const fetchMock = vi.fn(async (_url: string, init: RequestInit = {}) => {
      if (init.method === "GET") return new Response("", { status: 200 });
      const headers = init.headers as Record<string, string>;
      expect(headers["x-agent-token"]).toBe("correct-token-0123456789abcdef");
      expect(JSON.parse(init.body as string)).toEqual({
        url: "https://boards.greenhouse.io/acme/jobs/12345",
        company: "Acme Robotics",
        jobTitle: "Software Engineering Intern",
        location: "Boston, MA",
        eligibilityScore: 0.65,
        tailoredResumeDocumentId: "doc-resume-1",
        tailoredCoverLetterDocumentId: "doc-cover-1",
        startAutofill: false,
      });
      return new Response(
        JSON.stringify({ ok: true, data: { id: "session-abc", sessionId: "session-abc" } }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("./route");
    const response = await POST(makeRequest(requestBody()), {});
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      id: "session-abc",
      officialApplicationUrl: "https://boards.greenhouse.io/acme/jobs/12345",
      sourceListingUrl: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The token must never appear anywhere in the browser-facing response.
    expect(JSON.stringify(body)).not.toContain("correct-token-0123456789abcdef");
    expect(JSON.stringify(body)).not.toContain("contentBase64");
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain("correct-token-0123456789abcdef");
      expect(String(url)).not.toContain("contentBase64");
    }
  });

  it("returns AGENT_TOKEN_NOT_CONFIGURED when no token is configured anywhere", async () => {
    findUniqueMock.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("./route");
    const response = await POST(makeRequest(requestBody()), {});
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("AGENT_TOKEN_NOT_CONFIGURED");
    // Never even attempts the downstream call without a token.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns AGENT_AUTH_FAILED when the downstream agent rejects the token (401)", async () => {
    process.env.INTERNSHIP_AGENT_TOKEN = "wrong-token-0123456789abcdef";

    const fetchMock = vi.fn(async (_url: string, init: RequestInit = {}) =>
      init.method === "GET"
        ? new Response("", { status: 200 })
        : new Response(
        JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "bad token" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("./route");
    const response = await POST(makeRequest(requestBody()), {});
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBe("AGENT_AUTH_FAILED");
  });

  it("returns AGENT_SERVER_UNAVAILABLE when the downstream agent is unreachable", async () => {
    process.env.INTERNSHIP_AGENT_TOKEN = "some-token-0123456789abcdef";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const { POST } = await import("./route");
    const response = await POST(makeRequest(requestBody()), {});
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("AGENT_SERVER_UNAVAILABLE");
  });

  it("sends the token only via the x-agent-token header, never in the URL", async () => {
    process.env.INTERNSHIP_AGENT_TOKEN = "correct-token-0123456789abcdef";

    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (init.method === "GET") {
        expect((init.headers as Record<string, string> | undefined)?.["x-agent-token"]).toBeUndefined();
        return new Response("", { status: 200 });
      }
      expect(url).not.toContain("correct-token-0123456789abcdef");
      expect((init.headers as Record<string, string>)["x-agent-token"]).toBe(
        "correct-token-0123456789abcdef",
      );
      return new Response(JSON.stringify({ ok: true, data: { id: "session-abc" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("./route");
    await POST(makeRequest(requestBody()), {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["http://localhost:4317/", "http://[::1]:4317"])(
    "normalizes configured loopback base URL %s to the agent's IPv4 listener",
    async (configuredBaseUrl) => {
      process.env.INTERNSHIP_AGENT_TOKEN = "correct-token-0123456789abcdef";
      process.env.INTERNSHIP_AGENT_BASE_URL = configuredBaseUrl;
      const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
        if (init.method === "GET") return new Response("", { status: 200 });
        expect(url).toBe("http://127.0.0.1:4317/application-sessions");
        return new Response(JSON.stringify({ ok: true, data: { id: "session-abc" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const { POST } = await import("./route");
      expect((await POST(makeRequest(requestBody()), {})).status).toBe(200);
    },
  );

  it("rejects a non-loopback configured agent base URL", async () => {
    process.env.INTERNSHIP_AGENT_TOKEN = "correct-token-0123456789abcdef";
    process.env.INTERNSHIP_AGENT_BASE_URL = "https://agent.example.com";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./route");
    const response = await POST(makeRequest(requestBody()), {});
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "AGENT_BASE_URL_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns INVALID_PAYLOAD without calling the agent", async () => {
    process.env.INTERNSHIP_AGENT_TOKEN = "correct-token-0123456789abcdef";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./route");
    const response = await POST(makeRequest(requestBody({ company: "" })), {});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_PAYLOAD" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("intentionally rejects unknown legacy fields before calling the agent", async () => {
    process.env.INTERNSHIP_AGENT_TOKEN = "correct-token-0123456789abcdef";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./route");
    const response = await POST(
      makeRequest(requestBody({ officialApplyUrl: "https://boards.greenhouse.io/acme/jobs/12345" })),
      {},
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_PAYLOAD" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([-0.01, 1.01, 65, null])(
    "rejects non-canonical eligibilityScore %s",
    async (eligibilityScore) => {
      process.env.INTERNSHIP_AGENT_TOKEN = "correct-token-0123456789abcdef";
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { POST } = await import("./route");
      const response = await POST(makeRequest(requestBody({ eligibilityScore })), {});
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "INVALID_PAYLOAD" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("returns OFFICIAL_APPLICATION_URL_UNRESOLVED for a Jobright-only destination", async () => {
    process.env.INTERNSHIP_AGENT_TOKEN = "correct-token-0123456789abcdef";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<html><body>No original destination</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const { POST } = await import("./route");
    const response = await POST(
      makeRequest(requestBody({ url: "https://jobright.ai/jobs/info/example" })),
      {},
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "OFFICIAL_APPLICATION_URL_UNRESOLVED" });
  });
});

// Route handlers authenticate through this module. The tests below call them
// directly, so a session has to exist; who it belongs to is exercised by
// src/lib/auth/multiUserIsolation.test.ts against a real database.
vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
  const user = { id: "test-user", email: "test@example.test", name: "Test", image: null, emailVerified: true };
  return {
    ...actual,
    currentUser: async () => user,
    requireUser: async () => user,
    guardSession: async () => null,
    withUser:
      <C>(handler: (request: Request, sessionUser: typeof user, context: C) => Promise<Response>) =>
      async (request: Request, context: C) =>
        handler(request, user, context),
  };
});
