import { beforeEach, describe, expect, it, vi } from "vitest";

const userProfileUpsert = vi.fn();
const preferencesUpsert = vi.fn();
const sensitiveUpsert = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    userProfile: {
      upsert: (...args: unknown[]) => userProfileUpsert(...args),
      findUnique: async () => null,
    },
    applicationPreferences: {
      upsert: (...args: unknown[]) => preferencesUpsert(...args),
      findUnique: async () => null,
    },
    sensitiveAnswerPreferences: {
      upsert: (...args: unknown[]) => sensitiveUpsert(...args),
      findUnique: async () => null,
    },
    education: { findFirst: async () => null },
  },
}));

import { POST } from "./route";

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/application-profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    {} as never,
  );
}

describe("POST /api/application-profile", () => {
  beforeEach(() => vi.resetAllMocks());

  it("persists the work-authorization choice instead of dropping it", async () => {
    const response = await post({ legallyAuthorizedToWork: true });

    expect(response.status).toBe(200);
    expect(preferencesUpsert).toHaveBeenCalledTimes(1);
    const call = preferencesUpsert.mock.calls[0][0];
    expect(call.where).toEqual({ userId: "test-user" });
    expect(call.create.legallyAuthorizedToWork).toBe(true);
    expect(call.update.legallyAuthorizedToWork).toBe(true);
  });

  it("persists EEO answers to the sensitive preferences row, scoped to the session user", async () => {
    const response = await post({
      eeoGender: "Man",
      eeoVeteranStatus: "I am not a protected veteran",
    });

    expect(response.status).toBe(200);
    expect(sensitiveUpsert).toHaveBeenCalledTimes(1);
    const call = sensitiveUpsert.mock.calls[0][0];
    expect(call.where).toEqual({ userId: "test-user" });
    expect(call.create.gender).toBe("Man");
    expect(call.create.veteranStatus).toBe("I am not a protected veteran");
  });

  it("rejects a malformed body", async () => {
    const response = await POST(
      new Request("http://localhost/api/application-profile", { method: "POST", body: "not json" }),
      {} as never,
    );
    expect(response.status).toBe(400);
    expect(preferencesUpsert).not.toHaveBeenCalled();
    expect(sensitiveUpsert).not.toHaveBeenCalled();
  });
});

// Route handlers authenticate through this module. The tests above call them
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
