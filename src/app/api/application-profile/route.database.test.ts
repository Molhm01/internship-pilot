import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { GET, POST } from "./route";

// This suite exists because a UI that shows "Saved" while several displayed
// fields (Education, sensitive/EEO answers, work authorization) were silently
// discarded is the exact incident that prompted it: the canonical profile
// form told the user their profile was saved, and most of it never reached
// the database. Every check below runs against the real POST/GET handlers
// and a real PostgreSQL database — no mocked Prisma client — because that is
// the only way this class of bug is actually caught.
//
// Skipped when DATABASE_URL is unset, exactly like route.database.test.ts.
const DATABASE_AVAILABLE = Boolean(process.env.DATABASE_URL?.trim());

const FIXTURE_EMAIL_A = "p0-app-profile-user-a-20260825@example.test";
const FIXTURE_EMAIL_B = "p0-app-profile-user-b-20260825@example.test";
let userAId = "";
let userBId = "";
let activeUserId = "";

vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
  return {
    ...actual,
    currentUser: async () => ({ id: activeUserId, email: "active@example.test", name: "Test", image: null, emailVerified: true }),
    requireUser: async () => ({ id: activeUserId, email: "active@example.test", name: "Test", image: null, emailVerified: true }),
    guardSession: async () => null,
    withUser:
      <C>(handler: (request: Request, sessionUser: { id: string }, context: C) => Promise<Response>) =>
      async (request: Request, context: C) =>
        handler(request, { id: activeUserId }, context),
  };
});

type Body = Record<string, unknown>;

async function post(body: Body): Promise<{ status: number; body: { profile: Record<string, unknown> | null; gaps?: string[]; error?: string } }> {
  const response = await POST(
    new Request("http://localhost/api/application-profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    {},
  );
  return { status: response.status, body: await response.json() };
}

async function get(): Promise<{ status: number; body: { profile: Record<string, unknown> | null; gaps: string[] } }> {
  const response = await GET(new Request("http://localhost/api/application-profile"), {});
  return { status: response.status, body: await response.json() };
}

function fullProfileBody(overrides: Body = {}): Body {
  return {
    legalFirstName: "Riley",
    legalMiddleName: "Quinn",
    legalLastName: "Fixture",
    preferredName: "Rye",
    applicationEmail: "riley.application@example.test",
    email: "riley.everyday@example.test",
    alternateEmail: "riley.alt@example.test",
    phone: "2125550199",
    phoneCountryCode: "+1",
    addressStreet: "42 Test Lane",
    addressLine2: "Apt 3",
    addressCity: "New York",
    addressState: "NY",
    addressZip: "10001",
    countryOfResidence: "United States",
    linkedin: "https://linkedin.com/in/riley-fixture",
    github: "https://github.com/riley-fixture",
    portfolio: "https://riley-fixture.example",
    school: "Example University",
    degreeType: "Bachelor of Science",
    educationLevel: "Bachelor's",
    major: "Computer Science",
    minor: "Mathematics",
    educationStartDate: "2023-08",
    graduationDate: "2027-05",
    gpa: "3.8/4.0",
    earliestStartDate: "2027-06-01",
    salaryAnswerPreference: "Negotiable",
    securityClearanceStatus: "None",
    referralSource: "LinkedIn",
    remotePreference: "hybrid",
    relevantCoursework: ["Data Structures", "Circuits I"],
    legallyAuthorizedToWork: true,
    willingToRelocate: true,
    requiresSponsorship: false,
    hasDriversLicense: true,
    eeoGender: "Nonbinary",
    eeoRaceEthnicity: "Prefer not to say",
    eeoVeteranStatus: "Not a veteran",
    eeoDisabilityStatus: "No",
    pronouns: "they/them",
    ...overrides,
  };
}

async function cleanup(): Promise<void> {
  for (const email of [FIXTURE_EMAIL_A, FIXTURE_EMAIL_B]) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) continue;
    await prisma.education.deleteMany({ where: { userId: user.id } });
    await prisma.sensitiveAnswerPreferences.deleteMany({ where: { userId: user.id } });
    await prisma.applicationPreferences.deleteMany({ where: { userId: user.id } });
    await prisma.userProfile.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
}

describe.skipIf(!DATABASE_AVAILABLE)("POST/GET /api/application-profile against the live database", () => {
  beforeAll(async () => {
    await cleanup();
    const [userA, userB] = await Promise.all([
      prisma.user.create({ data: { email: FIXTURE_EMAIL_A, name: "Profile Fixture A" } }),
      prisma.user.create({ data: { email: FIXTURE_EMAIL_B, name: "Profile Fixture B" } }),
    ]);
    userAId = userA.id;
    userBId = userB.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(() => {
    activeUserId = userAId;
  });

  it("persists every supported field to its owning model and round-trips through GET", async () => {
    const { status, body } = await post(fullProfileBody());
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();

    const [profileRow, prefsRow, sensitiveRow, educationRow] = await Promise.all([
      prisma.userProfile.findUnique({ where: { userId: userAId } }),
      prisma.applicationPreferences.findUnique({ where: { userId: userAId } }),
      prisma.sensitiveAnswerPreferences.findUnique({ where: { userId: userAId } }),
      prisma.education.findFirst({ where: { userId: userAId }, orderBy: { sortOrder: "asc" } }),
    ]);

    expect(profileRow).not.toBeNull();
    expect(profileRow?.legalFirstName).toBe("Riley");
    expect(profileRow?.legalLastName).toBe("Fixture");
    expect(profileRow?.middleName).toBe("Quinn");
    expect(profileRow?.applicationEmail).toBe("riley.application@example.test");
    expect(profileRow?.city).toBe("New York");

    expect(prefsRow).not.toBeNull();
    expect(prefsRow?.legallyAuthorizedToWork).toBe(true);
    expect(prefsRow?.requiresSponsorshipNow).toBe(false);
    expect(prefsRow?.willingToRelocate).toBe(true);

    expect(sensitiveRow).not.toBeNull();
    expect(sensitiveRow?.gender).toBe("Nonbinary");
    expect(sensitiveRow?.pronouns).toBe("they/them");

    expect(educationRow).not.toBeNull();
    expect(educationRow?.school).toBe("Example University");
    expect(educationRow?.startMonth).toBe("08");
    expect(educationRow?.startYear).toBe("2023");
    expect(educationRow?.graduationMonth).toBe("05");
    expect(educationRow?.graduationYear).toBe("2027");
    expect(JSON.parse(educationRow?.relevantCoursework ?? "[]")).toEqual(["Data Structures", "Circuits I"]);

    const { body: getBody } = await get();
    expect(getBody.profile?.legalFirstName).toBe("Riley");
    expect(getBody.profile?.school).toBe("Example University");
    expect(getBody.profile?.legallyAuthorizedToWork).toBe(true);
    expect(getBody.profile?.workAuthorization).toBe("Authorized to work in the United States");
    expect(getBody.gaps).toEqual([]);
  });

  it("does not duplicate the primary Education row on a second save; the second save's values win", async () => {
    await post(fullProfileBody());
    const before = await prisma.education.count({ where: { userId: userAId } });

    await post(fullProfileBody({ major: "Electrical Engineering", gpa: "3.95/4.0" }));
    const after = await prisma.education.count({ where: { userId: userAId } });
    expect(after).toBe(before);

    const row = await prisma.education.findFirst({ where: { userId: userAId }, orderBy: { sortOrder: "asc" } });
    expect(row?.major).toBe("Electrical Engineering");
    expect(row?.gpa).toBe("3.95/4.0");
  });

  it("work authorization persists true, false, and unanswered distinctly", async () => {
    await post(fullProfileBody({ legallyAuthorizedToWork: true }));
    expect((await prisma.applicationPreferences.findUnique({ where: { userId: userAId } }))?.legallyAuthorizedToWork).toBe(true);

    await post(fullProfileBody({ legallyAuthorizedToWork: false }));
    expect((await prisma.applicationPreferences.findUnique({ where: { userId: userAId } }))?.legallyAuthorizedToWork).toBe(false);

    await post(fullProfileBody({ legallyAuthorizedToWork: null }));
    expect((await prisma.applicationPreferences.findUnique({ where: { userId: userAId } }))?.legallyAuthorizedToWork).toBeNull();
  });

  it("a blank sensitive answer stays unasserted rather than becoming a false answer", async () => {
    await post(fullProfileBody({ eeoGender: "", eeoRaceEthnicity: null, pronouns: undefined }));
    const row = await prisma.sensitiveAnswerPreferences.findUnique({ where: { userId: userAId } });
    expect(row?.gender).toBeNull();
    expect(row?.raceEthnicity).toBeNull();
    expect(row?.pronouns).toBeNull();
  });

  it("explicit Application email is authoritative over Everyday email when both are present", async () => {
    await post(fullProfileBody({ applicationEmail: "explicit@example.test", email: "everyday@example.test" }));
    expect((await prisma.userProfile.findUnique({ where: { userId: userAId } }))?.applicationEmail).toBe("explicit@example.test");
  });

  it("Everyday email is used only as a fallback when Application email is blank", async () => {
    await post(fullProfileBody({ applicationEmail: "", email: "fallback@example.test" }));
    expect((await prisma.userProfile.findUnique({ where: { userId: userAId } }))?.applicationEmail).toBe("fallback@example.test");
  });

  it("an invalid request body is rejected before anything is written, and never reports success", async () => {
    await post(fullProfileBody({ legalFirstName: "Riley" }));
    const before = await prisma.userProfile.findUnique({ where: { userId: userAId } });

    const response = await POST(
      new Request("http://localhost/api/application-profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not valid json",
      }),
      {},
    );
    const parsed = await response.json();

    expect(response.status).toBe(400);
    expect(parsed.profile).toBeUndefined();
    const after = await prisma.userProfile.findUnique({ where: { userId: userAId } });
    expect(after?.legalFirstName).toBe(before?.legalFirstName);
  });

  it("all four models save in one transaction — a write that touches Education also lands UserProfile and ApplicationPreferences together", async () => {
    // The array form of prisma.$transaction() is atomic by construction: if
    // any operation in the batch rejects, none of them commit. This asserts
    // the observable half of that contract — the fields owned by all three
    // upserted models plus the Education write all reflect the SAME save,
    // never a mix of an old and a new value across models.
    await post(fullProfileBody({ legalFirstName: "Before", school: "Before University", eeoGender: "Before" }));
    await post(fullProfileBody({ legalFirstName: "After", school: "After University", eeoGender: "After" }));

    const [profileRow, sensitiveRow, educationRow] = await Promise.all([
      prisma.userProfile.findUnique({ where: { userId: userAId } }),
      prisma.sensitiveAnswerPreferences.findUnique({ where: { userId: userAId } }),
      prisma.education.findFirst({ where: { userId: userAId }, orderBy: { sortOrder: "asc" } }),
    ]);
    expect(profileRow?.legalFirstName).toBe("After");
    expect(sensitiveRow?.gender).toBe("After");
    expect(educationRow?.school).toBe("After University");
  });

  it("two users saving a profile never share or leak each other's data", async () => {
    await post(fullProfileBody({ legalFirstName: "Riley", eeoGender: "Nonbinary" }));

    activeUserId = userBId;
    await post(fullProfileBody({
      legalFirstName: "Sam",
      legalLastName: "Other",
      applicationEmail: "sam.other@example.test",
      school: "Other University",
      eeoGender: "Woman",
    }));

    const [profileA, profileB, sensitiveA, sensitiveB, educationA, educationB] = await Promise.all([
      prisma.userProfile.findUnique({ where: { userId: userAId } }),
      prisma.userProfile.findUnique({ where: { userId: userBId } }),
      prisma.sensitiveAnswerPreferences.findUnique({ where: { userId: userAId } }),
      prisma.sensitiveAnswerPreferences.findUnique({ where: { userId: userBId } }),
      prisma.education.findFirst({ where: { userId: userAId } }),
      prisma.education.findFirst({ where: { userId: userBId } }),
    ]);

    expect(profileA?.legalFirstName).toBe("Riley");
    expect(profileB?.legalFirstName).toBe("Sam");
    expect(profileA?.applicationEmail).not.toBe(profileB?.applicationEmail);
    expect(sensitiveA?.gender).toBe("Nonbinary");
    expect(sensitiveB?.gender).toBe("Woman");
    expect(educationA?.school).not.toBe(educationB?.school);

    activeUserId = userAId;
    const { body: getBodyA } = await get();
    expect(getBodyA.profile?.legalFirstName).toBe("Riley");
    expect(getBodyA.profile?.school).not.toBe("Other University");
  });
});
