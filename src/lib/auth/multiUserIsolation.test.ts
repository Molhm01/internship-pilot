import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";

/**
 * Two users, one shared job catalogue, and no way across.
 *
 * These run against a real PostgreSQL database through the real Prisma Client,
 * with no mocked ORM: the thing being tested is whether a *query* can reach
 * another account's rows, and a mocked query proves nothing about that.
 *
 * The session is the one thing stubbed, because it is the input under test.
 * Each case declares who is asking and then calls the route exactly as the
 * browser would — so a route that forgot its owner filter fails here rather
 * than in production.
 *
 * Everything created is namespaced and removed afterwards. Canonical rows that
 * already existed are never touched: the fixtures are two throwaway accounts
 * and one throwaway job.
 */

const DATABASE_AVAILABLE = Boolean(process.env.DATABASE_URL?.trim());

const RUN_ID = `iso-${Date.now()}`;
const EMAIL_A = `${RUN_ID}-a@example.test`;
const EMAIL_B = `${RUN_ID}-b@example.test`;

/** Who the stubbed session says is asking. Set per test. */
let asking: { id: string; email: string } | null = null;

vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
  const currentUser = async () =>
    asking
      ? { id: asking.id, email: asking.email, name: "Test", image: null, emailVerified: true }
      : null;
  return {
    ...actual,
    currentUser,
    requireUser: async () => {
      const user = await currentUser();
      if (!user) throw new actual.UnauthenticatedError();
      return user;
    },
    guardSession: async () => (asking ? null : actual.unauthorizedResponse()),
    withUser:
      <C>(handler: (request: Request, user: unknown, context: C) => Promise<Response>) =>
      async (request: Request, context: C) => {
        const user = await currentUser();
        if (!user) return actual.unauthorizedResponse();
        return handler(request, user, context);
      },
  };
});

let userA = "";
let userB = "";
let jobId = "";

async function seed() {
  const a = await prisma.user.create({
    data: { email: EMAIL_A, name: "User A" },
    select: { id: true },
  });
  const b = await prisma.user.create({
    data: { email: EMAIL_B, name: "User B" },
    select: { id: true },
  });
  userA = a.id;
  userB = b.id;

  const job = await prisma.job.create({
    data: {
      title: `${RUN_ID} Electrical Engineering Intern`,
      company: `${RUN_ID} Test Employer`,
      description: "A fixture posting created by the multi-user isolation suite.",
      activeFeed: false,
    },
    select: { id: true },
  });
  jobId = job.id;
}

async function cleanup() {
  // Cascades take the private rows with the users; the job is deleted by id.
  await prisma.user.deleteMany({ where: { email: { in: [EMAIL_A, EMAIL_B] } } });
  if (jobId) await prisma.job.deleteMany({ where: { id: jobId } });
}

describe.skipIf(!DATABASE_AVAILABLE)("multi-user isolation", () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
    asking = null;
    await prisma.$disconnect();
  });

  describe("the job catalogue is shared", () => {
    it("shows the same canonical job to both users", async () => {
      const { GET } = await import("@/app/api/jobs/[id]/route");
      const params = Promise.resolve({ id: jobId });

      asking = { id: userA, email: EMAIL_A };
      const seenByA = await (await GET(new Request("http://localhost/api/jobs/x"), { params })).json();

      asking = { id: userB, email: EMAIL_B };
      const seenByB = await (
        await GET(new Request("http://localhost/api/jobs/x"), { params: Promise.resolve({ id: jobId }) })
      ).json();

      expect(seenByA.job.id).toBe(jobId);
      expect(seenByB.job.id).toBe(jobId);
      expect(seenByA.job.title).toBe(seenByB.job.title);
      expect(seenByA.job.description).toBe(seenByB.job.description);
    });
  });

  describe("match scores are per user", () => {
    it("keeps two different scores for the same job", async () => {
      await prisma.userJobState.create({
        data: { userId: userA, jobId, matchScore: 91, eligibilityStatus: "Pass" },
      });
      await prisma.userJobState.create({
        data: { userId: userB, jobId, matchScore: 63, eligibilityStatus: "Pass" },
      });

      const { GET } = await import("@/app/api/jobs/[id]/route");

      asking = { id: userA, email: EMAIL_A };
      const a = await (
        await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: jobId }) })
      ).json();

      asking = { id: userB, email: EMAIL_B };
      const b = await (
        await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: jobId }) })
      ).json();

      // Both values coexist. Neither overwrote the other.
      expect(a.job.matchScore).toBe(91);
      expect(b.job.matchScore).toBe(63);
    });
  });

  describe("tracker status is per user", () => {
    it("does not move B's status when A applies", async () => {
      const { PATCH, GET } = await import("@/app/api/jobs/[id]/route");

      asking = { id: userA, email: EMAIL_A };
      await PATCH(
        new Request("http://localhost/x", {
          method: "PATCH",
          body: JSON.stringify({ status: "SUBMITTED" }),
        }),
        { params: Promise.resolve({ id: jobId }) },
      );

      asking = { id: userA, email: EMAIL_A };
      const a = await (
        await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: jobId }) })
      ).json();
      asking = { id: userB, email: EMAIL_B };
      const b = await (
        await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: jobId }) })
      ).json();

      expect(a.job.status).toBe("SUBMITTED");
      expect(b.job.status).not.toBe("SUBMITTED");
    });
  });

  describe("private rows are unreachable across accounts", () => {
    it("does not return B's résumé facts to A", async () => {
      await prisma.resumeFact.create({
        data: { userId: userB, type: "skill", content: "B-only fact", status: "approved" },
      });
      const { GET } = await import("@/app/api/resume/facts/route");

      asking = { id: userA, email: EMAIL_A };
      const body = await (await GET(new Request("http://localhost/api/resume/facts"), {})).json();

      expect(body.facts).toHaveLength(0);
    });

    it("refuses a direct-id read of B's generated document", async () => {
      const document = await prisma.generatedDocument.create({
        data: {
          userId: userB,
          jobId,
          type: "resume",
          storagePath: `data/generated/users/${userB}/jobs/${jobId}/resume-v1.pdf`,
          qaStatus: "pass",
          identityVerified: true,
        },
        select: { id: true },
      });

      const { GET } = await import("@/app/api/documents/[id]/download/route");

      asking = { id: userA, email: EMAIL_A };
      const response = await GET(new Request("http://localhost/x"), {
        params: Promise.resolve({ id: document.id }),
      });

      // 404, not 403: a document that is not yours is indistinguishable from
      // one that does not exist, so id-walking learns nothing.
      expect(response.status).toBe(404);
    });

    it("does not return B's application runs on a shared job", async () => {
      await prisma.applicationRun.create({
        data: { userId: userB, jobId, mode: "fill_only", atsType: "greenhouse", status: "filled" },
      });
      const { GET } = await import("@/app/api/jobs/[id]/applications/route");

      asking = { id: userA, email: EMAIL_A };
      const body = await (
        await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: jobId }) })
      ).json();

      expect(body.runs).toHaveLength(0);
    });

    it("does not return B's approved answers, education or profile to A", async () => {
      await prisma.approvedAnswer.create({
        data: { userId: userB, questionText: `${RUN_ID} why this company`, answer: "B's answer" },
      });
      await prisma.education.create({
        data: { userId: userB, school: `${RUN_ID} B University` },
      });
      await prisma.userProfile.create({
        data: { userId: userB, legalFirstName: "Bee", phone: "555-0100" },
      });

      const { GET } = await import("@/app/api/profile/route");

      asking = { id: userA, email: EMAIL_A };
      const body = await (await GET()).json();

      const answers = (body.answers ?? []) as { questionText: string }[];
      const educations = (body.educations ?? []) as { school: string }[];
      expect(answers.some((answer) => answer.questionText.includes(RUN_ID))).toBe(false);
      expect(educations.some((entry) => entry.school.includes(RUN_ID))).toBe(false);
      // A has entered nothing, so A sees nothing — not B's name and telephone.
      expect(body.profile).toBeNull();

      // And the reverse direction, so this is isolation rather than an empty
      // account happening to look empty.
      asking = { id: userB, email: EMAIL_B };
      const seenByB = await (await GET()).json();
      expect(seenByB.profile?.legalFirstName).toBe("Bee");
      expect((seenByB.educations as { school: string }[]).some((entry) => entry.school.includes(RUN_ID))).toBe(true);
    });

    it("does not return B's saved filters to A", async () => {
      await prisma.savedFilter.create({
        data: { userId: userB, name: `${RUN_ID} B filter`, filterJson: "{}" },
      });
      const { GET } = await import("@/app/api/filters/saved/route");

      asking = { id: userA, email: EMAIL_A };
      const body = await (await GET(new Request("http://localhost/api/filters/saved"), {})).json();
      const names = (body.filters as { name: string }[]).map((filter) => filter.name);

      expect(names).not.toContain(`${RUN_ID} B filter`);
    });

    it("does not return B's assessments to A", async () => {
      await prisma.assessmentInboxEntry.create({
        data: { userId: userB, company: `${RUN_ID} employer` },
      });
      const { GET } = await import("@/app/api/assessments/route");

      asking = { id: userA, email: EMAIL_A };
      const body = await (await GET(new Request("http://localhost/api/assessments"), {})).json();

      expect(body.entries).toHaveLength(0);
    });

    it("reports B's company facts as unknown to A", async () => {
      await prisma.companyRelationshipFact.create({
        data: {
          userId: userB,
          companyKey: `${RUN_ID} employer`,
          companyName: `${RUN_ID} Employer`,
          previouslyEmployed: true,
        },
      });
      const { GET } = await import("@/app/api/profile/company-facts/route");

      asking = { id: userA, email: EMAIL_A };
      const body = await (
        await GET(
          new Request(`http://localhost/api/profile/company-facts?company=${RUN_ID}%20Employer`),
          {},
        )
      ).json();

      // Not "false" — absent. "We do not know" has to survive, or the agent
      // would answer "have you worked here before" from another person's row.
      expect(body.fact).toBeNull();
    });
  });

  describe("query-parameter tampering", () => {
    it("ignores a userId supplied in the query string", async () => {
      const { GET } = await import("@/app/api/resume/facts/route");

      asking = { id: userA, email: EMAIL_A };
      const body = await (
        await GET(new Request(`http://localhost/api/resume/facts?userId=${userB}`), {})
      ).json();

      // The B-only fact created above must not appear, whatever the URL says.
      expect(body.facts).toHaveLength(0);
    });
  });

  describe("unauthenticated requests", () => {
    it("answers 401 rather than data", async () => {
      const { GET } = await import("@/app/api/resume/facts/route");
      asking = null;
      const response = await GET(new Request("http://localhost/api/resume/facts"), {});
      expect(response.status).toBe(401);
    });
  });
});
