import "dotenv/config";
import { prisma } from "@/lib/db";
import { applicationActiveKey, enqueueApplication } from "@/lib/applications/queue";
import { setApplicationMode } from "@/lib/applications/settings";
import { computeDocumentFingerprint } from "@/lib/documents/documentFingerprint";

const EMAIL_A = "application-isolation-a@example.test";
const EMAIL_B = "application-isolation-b@example.test";
const COMPANY = "Application Isolation Fixture Co";
let failures = 0;

function check(condition: boolean, message: string) {
  if (condition) console.log(`  PASS: ${message}`);
  else {
    console.error(`  FAIL: ${message}`);
    failures += 1;
  }
}

async function cleanup() {
  const jobs = await prisma.job.findMany({ where: { company: COMPANY }, select: { id: true } });
  const jobIds = jobs.map((job) => job.id);
  if (jobIds.length) {
    await prisma.applicationRun.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.generatedDocument.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.matchResult.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.userJobState.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { in: [EMAIL_A, EMAIL_B] } } });
}

async function makePrivateInputs(userId: string, jobId: string, score: number, suffix: string) {
  const match = await prisma.matchResult.create({
    data: {
      userId,
      jobId,
      eligibility: "Pass",
      eligibilityReason: `Fixture eligibility ${suffix}`,
      score,
      explanation: `Fixture explanation ${suffix}`,
      recommendation: "Apply",
      skillsSupported: "[]",
      skillsNeedConfirmation: "[]",
      skillsToLearn: "[]",
      skillsNeverAdd: "[]",
      factsUsed: "[]",
      origin: "MANUAL",
    },
  });
  // enqueueApplication only reuses a document whose stored fingerprint still
  // matches the CURRENT freshness fingerprint (see
  // src/lib/documents/applicationReadiness.ts); a document inserted without
  // one is indistinguishable from a stale one and is never reused. Computing
  // the real fingerprint here — after the match this fixture just created —
  // is what makes this an "intentionally approved current job-scoped
  // document" rather than a fixture the production contract would reject.
  const fingerprint = await computeDocumentFingerprint(jobId, userId);
  const resume = await prisma.generatedDocument.create({
    data: {
      userId,
      jobId,
      type: "resume",
      version: 1,
      storagePath: `data/generated/${userId}/${jobId}/resume-${suffix}.pdf`,
      qaStatus: "pass",
      tailoringStatus: "TAILORED_WITH_SUPPORTED_CHANGES",
      identityVerified: true,
      bulletIdsUsed: "[]",
      matchResultId: match.id,
      documentFingerprint: fingerprint,
    },
  });
  return { match, resume };
}

async function main() {
  await cleanup();

  const [userA, userB] = await Promise.all([
    prisma.user.create({ data: { email: EMAIL_A, name: "Isolation User A" } }),
    prisma.user.create({ data: { email: EMAIL_B, name: "Isolation User B" } }),
  ]);
  await Promise.all([
    setApplicationMode(userA.id, "FILL_TO_SUBMIT"),
    setApplicationMode(userB.id, "FILL_TO_SUBMIT"),
  ]);

  const job = await prisma.job.create({
    data: {
      title: "Electrical Engineering Intern",
      company: COMPANY,
      description: "A sufficiently detailed fixture description for a shared catalogue job. ".repeat(8),
      source: "greenhouse",
      verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
      url: "https://boards.greenhouse.io/example/jobs/123456",
      officialApplyUrl: "https://boards.greenhouse.io/example/jobs/123456",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    },
  });

  const privateA = await makePrivateInputs(userA.id, job.id, 91, "a");
  const privateB = await makePrivateInputs(userB.id, job.id, 42, "b");

  console.log("1) User A queues with only User A private data");
  const queuedA = await enqueueApplication(job.id, userA.id);
  const runA = await prisma.applicationRun.findUnique({ where: { id: queuedA.runId } });
  check(runA?.userId === userA.id, "run A belongs to user A");
  check(runA?.resumeDocumentId === privateA.resume.id, "run A attached only user A's resume");
  check(runA?.matchScoreAtRun === 91, "run A captured only user A's score");
  check(runA?.activeKey === applicationActiveKey(userA.id, job.id), "run A duplicate guard is owner-scoped");

  // A submitted application is terminal and belongs to A. It must not prevent
  // B from applying to the same shared catalogue row.
  await prisma.applicationRun.update({
    where: { id: queuedA.runId },
    data: { status: "submitted", activeKey: null, finishedAt: new Date() },
  });

  console.log("\n2) User B can independently queue the same requisition");
  const queuedB = await enqueueApplication(job.id, userB.id);
  const runB = await prisma.applicationRun.findUnique({ where: { id: queuedB.runId } });
  check(queuedB.runId !== queuedA.runId, "user B receives a distinct ApplicationRun");
  check(runB?.userId === userB.id, "run B belongs to user B");
  check(runB?.resumeDocumentId === privateB.resume.id, "run B attached only user B's resume");
  check(runB?.resumeDocumentId !== privateA.resume.id, "run B never reused user A's resume");
  check(runB?.matchScoreAtRun === 42, "run B captured only user B's score");
  check(runB?.activeKey === applicationActiveKey(userB.id, job.id), "run B duplicate guard is owner-scoped");

  console.log("\n3) Tracker state is per user, not written to shared Job.status");
  const [stateA, stateB, sharedJob] = await Promise.all([
    prisma.userJobState.findUnique({ where: { userId_jobId: { userId: userA.id, jobId: job.id } } }),
    prisma.userJobState.findUnique({ where: { userId_jobId: { userId: userB.id, jobId: job.id } } }),
    prisma.job.findUnique({ where: { id: job.id } }),
  ]);
  check(stateA?.applicationStatus === "APPLYING", "user A tracker state is APPLYING");
  check(stateB?.applicationStatus === "APPLYING", "user B tracker state is APPLYING");
  check(sharedJob?.status === "DISCOVERED", "shared deprecated Job.status was not mutated by either user");

  console.log("\n4) Exactly two owner-scoped runs exist for the shared job");
  const runs = await prisma.applicationRun.findMany({ where: { jobId: job.id }, orderBy: { createdAt: "asc" } });
  check(runs.length === 2, `two runs exist (got ${runs.length})`);
  check(new Set(runs.map((run) => run.userId)).size === 2, "the two runs have different owners");

  await cleanup();
  console.log(failures === 0 ? "\nAll application multi-user isolation tests PASSED." : `\n${failures} isolation test(s) FAILED.`);
  if (failures) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("Application multi-user isolation test crashed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
