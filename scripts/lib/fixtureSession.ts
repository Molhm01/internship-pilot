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
  await seedFixtureEvidence(userId);

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

/**
 * The approved résumé evidence the fixture account applies from.
 *
 * Document generation refuses to run for a user with no approved facts, which
 * is the correct rule — a tailored résumé is assembled from evidence the
 * applicant confirmed, and there is nothing honest to write without any. So a
 * fixture that generates documents has to supply that evidence rather than work
 * around the check.
 *
 * The content mirrors the master résumé's own claims, because that is what the
 * tailoring audit matches against when it decides which keywords a posting may
 * be answered with: an unsupported requirement stays out of the PDF, and the
 * fixture only gets the supported ones because these facts exist.
 */
export async function seedFixtureEvidence(userId: string): Promise<void> {
  const existing = await prisma.resumeFact.count({ where: { userId } });
  if (existing > 0) return;

  const facts: Array<{ type: string; content: string; detail: string }> = [
    { type: "experience", content: "PC Builder and Repair Technician", detail: "Built 30+ custom PCs and completed 100+ hardware repairs; diagnosed desktop and laptop issues and handled component replacement of RAM, SSDs, GPUs, and cooling." },
    { type: "skill", content: "Hardware diagnostics", detail: "PC assembly, diagnostics, and component replacement across 5–10 jobs per month at peak." },
    { type: "project", content: "Air Quality Monitor — VOC Detection", detail: "Sampled MQ-135 sensor data to an OLED display and designed and 3D-printed a ventilated enclosure for the sensor, display, and electronics." },
    { type: "project", content: "Automated Plant-Watering System", detail: "Soil-moisture sensor readings driving pump cycles, with a 3D printing enclosure design for the sensors, pump, and wiring." },
    { type: "skill", content: "SolidWorks", detail: "CAD modelling for enclosure design and 3D printing." },
    { type: "skill", content: "Circuit prototyping", detail: "Breadboarding, analog sensor interfacing, and OLED integration on Arduino." },
    { type: "education", content: "B.S. Electrical Engineering", detail: "Digital Design, Circuits & Systems I, Differential Equations." },
  ];

  await prisma.resumeFact.createMany({
    data: facts.map((fact) => ({ ...fact, userId, status: "approved", source: "manual" })),
  });
}
