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

  it("reads only the newest saved match without changing existing records", async () => {
    const newest = { id: "match-v2", score: 91, eligibility: "Pass", createdAt: new Date("2026-08-01T12:00:00Z") };
    const older = { id: "match-v1", score: 80, eligibility: "Unknown", createdAt: new Date("2026-08-01T11:00:00Z") };
    findUnique.mockResolvedValue({ id: "job-1", userStates: [],
      matchResults: [newest] });

    const response = await GET(
      new Request("http://localhost/api/jobs/job-1"),
      { params: Promise.resolve({ id: "job-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    // Both includes are owner-scoped: the newest match is THIS user's newest
    // match, not the newest anybody has recorded against a shared posting.
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "job-1" },
      include: {
        matchResults: {
          where: { userId: "test-user" },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        userStates: { where: { userId: "test-user" }, take: 1 },
      },
    });
    expect(body.job.matchResults.map((match: { id: string }) => match.id)).toEqual(["match-v2"]);
    expect(body.job.matchResults).not.toContainEqual(older);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("keeps the job page wired to the saved newest result after reload", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    const initialLoadStart = source.indexOf("if (initialLoadJobId.current === id) return;");
    const initialLoadEnd = source.indexOf("useEffect(() => () =>", initialLoadStart);
    const initialLoadEffect = source.slice(initialLoadStart, initialLoadEnd);

    expect(source).toContain("fetch(`/api/jobs/${id}`)");
    expect(source).toContain("setJob(data.job)");
    expect(source).toContain("const latestMatch = job.matchResults[0]");
    expect(source).toContain('latestMatch?.eligibility === "Unknown"');
    expect(source).toContain("runManualMatchAndRefresh({");
    expect(source).toContain("manualMatchToImmediateDisplay(result)");
    expect(source).toContain("activeMatchRequests.current.has(id)");
    expect(source).toContain("matchingJobs[id] === true");
    expect(source).toContain("matchErrors[id] ?? null");
    expect(source).toContain("setMatchError(error instanceof Error ? error.message");
    expect(source).toContain("{matchError && (");
    expect(source).toContain("{latestMatch.score}/100");
    expect(source).toContain('SkillBucket variant="supported"');
    expect(source).toContain('SkillBucket variant="confirm"');
    expect(source).toContain('SkillBucket variant="learn"');
    expect(source).toContain('SkillBucket variant="never"');
    expect(source).toContain("new Date(latestMatch.createdAt).toLocaleString()");
    expect(source).toContain("initialLoadJobId.current === id");
    expect(source.match(/runManualMatchAndRefresh\(\{/g)).toHaveLength(1);
    expect(source).not.toContain("startVisiblePolling");
    expect(source).not.toContain("setInterval(");
    expect(source).not.toContain("router.refresh()");
    expect(source).not.toContain("void runMatch()");
    expect(source).not.toContain("runMatch();");
    expect(initialLoadEffect).toContain("Promise.all([load(), loadDocuments(), loadRuns(), loadAuditLog()])");
    expect(initialLoadEffect).not.toContain("runManualMatchAndRefresh");
    expect(initialLoadEffect).not.toContain("/api/match");
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
