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
      where: { jobId: "job-1" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  });
});
