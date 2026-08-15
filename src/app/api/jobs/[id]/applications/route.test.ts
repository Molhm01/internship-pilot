import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { applicationRun: { findMany: (...args: unknown[]) => findMany(...args) } },
}));

import { GET } from "./route";

describe("GET /api/jobs/[id]/applications", () => {
  beforeEach(() => vi.resetAllMocks());

  it("limits application history used by the job page", async () => {
    findMany.mockResolvedValue([{ id: "run-1" }]);

    const response = await GET(new Request("http://localhost/api/jobs/job-1/applications"), {
      params: Promise.resolve({ id: "job-1" }),
    });

    expect(response.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith({
      where: { jobId: "job-1", userId: "test-user" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
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
