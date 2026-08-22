import { prisma } from "@/lib/db";
import type { FixtureCandidate } from "./applicationFixtures";

/**
 * A real signed-in session for a fixture account.
 *
 * Every private route reads the signed session cookie and nothing else — a
 * `userId` in a body or a header is a claim the server does not accept. So a
 * fixture that wants to exercise those routes has to hold a genuine session,
 * and the honest way to get one is to sign up over HTTP exactly as a person
 * would. Minting a Session row by hand would test a path production never uses.
 */

export const FIXTURE_PASSWORD = "FixtureAudit!2026";

export type FixtureSession = {
  userId: string;
  email: string;
  /** Ready to send as a `cookie:` request header. */
  cookie: string;
};

function collectCookies(response: Response): string {
  const raw = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") ?? ""].filter(Boolean);
  return raw
    .map((entry) => entry.split(";")[0]!.trim())
    .filter(Boolean)
    .join("; ");
}

/** Signs a fixture account up through the real endpoint and keeps its cookie. */
export async function signUpFixtureUser(baseUrl: string, email: string, name: string): Promise<FixtureSession> {
  const response = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Better Auth rejects a state-changing request with no Origin as a CSRF
      // attempt. A browser always sends one; a fixture has to say so too.
      origin: baseUrl,
    },
    body: JSON.stringify({ email, password: FIXTURE_PASSWORD, name }),
  });
  if (!response.ok) {
    throw new Error(`Fixture sign-up failed (${response.status}): ${await response.text()}`);
  }
  const cookie = collectCookies(response);
  if (!cookie) throw new Error("Fixture sign-up returned no session cookie.");
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`Fixture sign-up did not create an account for ${email}.`);
  return { userId: user.id, email, cookie };
}

/**
 * Fills in the user-owned records the agent reads.
 *
 * Sign-up creates the account; these are the facts a person would enter on the
 * Application Profile page afterwards. Written straight to the owning models
 * because that is where they live — there is no shared profile row any more.
 */
export async function seedFixtureProfile(userId: string, candidate: FixtureCandidate): Promise<void> {
  await prisma.userProfile.upsert({
    where: { userId },
    create: {
      userId,
      legalFirstName: candidate.legalFirstName,
      legalLastName: candidate.legalLastName,
      applicationEmail: candidate.email,
      phone: candidate.phone,
      addressLine1: candidate.addressLine1,
      city: candidate.city,
      state: candidate.state,
      postalCode: "07102",
      country: "United States",
      linkedinUrl: `https://www.linkedin.com/in/${candidate.legalFirstName.toLowerCase()}-fixture/`,
    },
    update: {
      legalFirstName: candidate.legalFirstName,
      legalLastName: candidate.legalLastName,
      applicationEmail: candidate.email,
      phone: candidate.phone,
    },
  });
  await prisma.applicationPreferences.upsert({
    where: { userId },
    create: { userId, legallyAuthorizedToWork: true, requiresSponsorshipNow: false, willingToRelocate: true },
    update: { legallyAuthorizedToWork: true, requiresSponsorshipNow: false },
  });
  await prisma.sensitiveAnswerPreferences.upsert({
    where: { userId },
    create: { userId, declineDemographics: true },
    update: { declineDemographics: true },
  });
  const education = await prisma.education.findFirst({ where: { userId } });
  if (!education) {
    await prisma.education.create({
      data: {
        userId,
        school: candidate.school,
        degree: candidate.degree,
        major: "Electrical Engineering",
        graduationMonth: "05",
        graduationYear: "2029",
        educationLevel: "Bachelor's",
        sortOrder: 0,
      },
    });
  }
}
