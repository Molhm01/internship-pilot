import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    generatedDocument: {
      findMany: (...args: unknown[]) => findMany(...args),
    },
  },
}));

import { GET } from "./route";

describe("GET /api/jobs/[id]/documents", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns persisted versions newest-first for a page refresh", async () => {
    const documents = [
      { id: "cover-v2", type: "coverLetter", version: 2 },
      { id: "cover-v1", type: "coverLetter", version: 1 },
      { id: "resume-v2", type: "resume", version: 2 },
      { id: "resume-v1", type: "resume", version: 1 },
    ];
    findMany.mockResolvedValue(documents);

    const response = await GET(new Request("http://localhost/api/jobs/job-1/documents"), {
      params: Promise.resolve({ id: "job-1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ documents });
    expect(findMany).toHaveBeenCalledWith({
      where: { jobId: "job-1", userId: "test-user" },
      orderBy: [{ type: "asc" }, { version: "desc" }],
    });
  });

  it("returns a real server error instead of an empty document list", async () => {
    findMany.mockRejectedValue(new Error("database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET(new Request("http://localhost/api/jobs/job-1/documents"), {
      params: Promise.resolve({ id: "job-1" }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Saved tailored documents could not be loaded.",
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
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
