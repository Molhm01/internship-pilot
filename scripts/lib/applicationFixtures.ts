import { prisma } from "@/lib/db";

/**
 * The user-owned rows an application fixture needs, created from nothing.
 *
 * The point of building these rather than reading whatever happens to be in the
 * database is ownership. The retired `ApplicationProfile` singleton let a
 * fixture "have a profile" without anybody owning it, and a test written that
 * way cannot detect the failure that matters most here: one person's answers
 * reaching another person's form. Two fixture users, each with their own
 * profile, preferences, demographics, education and run, make that failure
 * visible.
 */

export type FixtureCandidate = {
  legalFirstName: string;
  legalLastName: string;
  email: string;
  phone: string;
  school: string;
  degree: string;
  city: string;
  state: string;
  addressLine1: string;
};

export type FixtureUser = {
  userId: string;
  email: string;
  candidate: FixtureCandidate;
};

/** Everything a fixture creates, so teardown can be exact rather than broad. */
export type FixtureWorld = {
  users: FixtureUser[];
  jobId: string;
  /** One run per user, in the same order as `users`. */
  runIds: string[];
};

export const FIXTURE_COMPANY = "Internship Pilot Fixture Employer";
export const FIXTURE_EMAIL_DOMAIN = "@fixture.internship-pilot.test";

export const CANDIDATE_A: FixtureCandidate = {
  legalFirstName: "Ada",
  legalLastName: "Fixture",
  email: `ada${FIXTURE_EMAIL_DOMAIN}`,
  phone: "+1 201 555 0143",
  school: "Fixture Institute of Technology",
  degree: "B.S. Electrical Engineering",
  city: "Newark",
  state: "NJ",
  addressLine1: "1 Fixture Way",
};

export const CANDIDATE_B: FixtureCandidate = {
  legalFirstName: "Bram",
  legalLastName: "Counterpart",
  email: `bram${FIXTURE_EMAIL_DOMAIN}`,
  phone: "+1 862 555 0198",
  school: "Counterpart State University",
  degree: "B.E. Computer Engineering",
  city: "Hoboken",
  state: "NJ",
  addressLine1: "2 Counterpart Street",
};

/** Creates one account and every user-owned record the agent reads. */
export async function createFixtureUser(candidate: FixtureCandidate): Promise<FixtureUser> {
  const user = await prisma.user.create({
    data: {
      email: candidate.email,
      name: `${candidate.legalFirstName} ${candidate.legalLastName}`,
      emailVerified: true,
    },
  });

  await prisma.userProfile.create({
    data: {
      userId: user.id,
      legalFirstName: candidate.legalFirstName,
      legalLastName: candidate.legalLastName,
      applicationEmail: candidate.email,
      phone: candidate.phone,
      addressLine1: candidate.addressLine1,
      city: candidate.city,
      state: candidate.state,
      postalCode: "07102",
      country: "United States",
    },
  });

  await prisma.applicationPreferences.create({
    data: {
      userId: user.id,
      legallyAuthorizedToWork: true,
      requiresSponsorshipNow: false,
      willingToRelocate: true,
      remotePreference: "Hybrid",
    },
  });

  // Demographics exist as an explicit decline, which is a real answer and the
  // one the agent is allowed to act on without asking.
  await prisma.sensitiveAnswerPreferences.create({
    data: { userId: user.id, declineDemographics: true },
  });

  await prisma.education.create({
    data: {
      userId: user.id,
      school: candidate.school,
      degree: candidate.degree,
      major: "Electrical Engineering",
      graduationMonth: "05",
      graduationYear: "2029",
      educationLevel: "Bachelor's",
      sortOrder: 0,
    },
  });

  await prisma.experience.create({
    data: {
      userId: user.id,
      employer: `${candidate.legalLastName} Fixture Lab`,
      title: "Undergraduate Research Assistant",
      currentlyEmployed: true,
      sortOrder: 0,
    },
  });

  return { userId: user.id, email: candidate.email, candidate };
}

/** One shared employer posting, exactly as two real users would both see it. */
export async function createFixtureJob(applyUrl: string): Promise<string> {
  const job = await prisma.job.create({
    data: {
      title: "Fixture Electrical Engineering Intern",
      company: FIXTURE_COMPANY,
      location: "Newark, NJ",
      description:
        "A deterministic fixture posting used by the publish-readiness suite. No employer system is contacted by any test that uses it.",
      url: applyUrl,
      officialApplyUrl: applyUrl,
      source: "application-worker-test",
      status: "DISCOVERED",
      verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
      verificationMethod: "local-fixture",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      lastVerifiedAt: new Date(),
    },
  });
  return job.id;
}

/** A user-owned run against the shared job. */
export async function createFixtureRun(userId: string, jobId: string): Promise<string> {
  const run = await prisma.applicationRun.create({
    data: {
      userId,
      jobId,
      mode: "fill_to_submit",
      atsType: "unknown",
      status: "queued",
    },
  });
  return run.id;
}

/**
 * Two users, one shared job, one run each.
 *
 * Two is the minimum that can prove isolation: with one fixture user, a query
 * that forgot its `where: { userId }` returns the right answer by accident.
 */
export async function createTwoUserWorld(applyUrl: string): Promise<FixtureWorld> {
  const users = [await createFixtureUser(CANDIDATE_A), await createFixtureUser(CANDIDATE_B)];
  const jobId = await createFixtureJob(applyUrl);
  const runIds: string[] = [];
  for (const user of users) runIds.push(await createFixtureRun(user.userId, jobId));
  return { users, jobId, runIds };
}

/**
 * Removes every row these fixtures create, including leftovers from a run that
 * crashed before its own teardown. Deleting the users cascades their private
 * data; the shared job has to go explicitly because nobody owns it.
 */
export async function cleanupFixtures(): Promise<void> {
  const jobs = await prisma.job.findMany({ where: { company: FIXTURE_COMPANY }, select: { id: true } });
  const jobIds = jobs.map((job) => job.id);
  if (jobIds.length) {
    await prisma.applicationRun.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.generatedDocument.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.matchResult.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.userJobState.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.initialAiMatchJob.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.auditLogEntry.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { endsWith: FIXTURE_EMAIL_DOMAIN } } });
}
