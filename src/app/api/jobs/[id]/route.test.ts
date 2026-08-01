import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    job: {
      findUnique: (...args: unknown[]) => findUnique(...args),
    },
  },
}));

import { GET } from "./route";

describe("GET /api/jobs/[id] saved match refresh", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns saved match versions newest-first for a page refresh", async () => {
    const newest = { id: "match-v2", score: 91, eligibility: "Pass", createdAt: new Date("2026-08-01T12:00:00Z") };
    const older = { id: "match-v1", score: 80, eligibility: "Unknown", createdAt: new Date("2026-08-01T11:00:00Z") };
    findUnique.mockResolvedValue({ id: "job-1", matchResults: [newest, older] });

    const response = await GET(
      new Request("http://localhost/api/jobs/job-1"),
      { params: Promise.resolve({ id: "job-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "job-1" },
      include: { matchResults: { orderBy: { createdAt: "desc" } } },
    });
    expect(body.job.matchResults.map((match: { id: string }) => match.id)).toEqual([
      "match-v2",
      "match-v1",
    ]);
  });

  it("keeps the job page wired to the saved newest result after reload", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/jobs/[id]/page.tsx"), "utf8");

    expect(source).toContain("fetch(`/api/jobs/${id}`)");
    expect(source).toContain("setJob(data.job)");
    expect(source).toContain("const latestMatch = job.matchResults[0]");
    expect(source).toContain("setMatchError(error instanceof Error ? error.message");
    expect(source).toContain("{matchError && (");
    expect(source).toContain('SkillBucket variant="supported"');
    expect(source).toContain('SkillBucket variant="never"');
  });
});
