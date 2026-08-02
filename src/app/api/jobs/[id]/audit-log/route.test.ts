import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { auditLogEntry: { findMany: (...args: unknown[]) => findMany(...args) } },
}));

import { GET } from "./route";

describe("GET /api/jobs/[id]/audit-log", () => {
  beforeEach(() => vi.resetAllMocks());

  it("loads only the most recent activity entries", async () => {
    findMany.mockResolvedValue([{ id: "audit-1" }]);

    const response = await GET(new Request("http://localhost/api/jobs/job-1/audit-log"), {
      params: Promise.resolve({ id: "job-1" }),
    });

    expect(response.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith({
      where: { jobId: "job-1" },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });
});
