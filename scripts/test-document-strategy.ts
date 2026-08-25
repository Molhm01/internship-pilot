import "dotenv/config";
import { prisma } from "@/lib/db";
import {
  jobDescriptionCompleteness,
  tailoringStatusForCompleteness,
  strategyFromTailoringStatus,
  isUsableResume,
} from "@/lib/documents/strategy";
import { enqueueApplication, ApplicationAgentError } from "@/lib/applications/queue";
import { setApplicationMode } from "@/lib/applications/settings";
import { computeDocumentFingerprint } from "@/lib/documents/documentFingerprint";

let failures = 0;
const TEST_EMAIL = "document-strategy-audit@example.test";
let userId = "";

function check(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS: ${msg}`);
  else { console.error(`  FAIL: ${msg}`); failures++; }
}

const COMPLETE = { description: "A".repeat(300), jobResponsibilities: JSON.stringify(["Do X", "Do Y"]), jobQualifications: JSON.stringify(["Know Z"]) };
const PARTIAL = { description: "A".repeat(300), jobResponsibilities: null, jobQualifications: null };
const NONE = { description: "short", jobResponsibilities: null, jobQualifications: null };

async function makeJob(overrides: Record<string, unknown>) {
  return prisma.job.create({
    data: {
      title: "Test Strategy Intern",
      company: "Test Strategy Co",
      description: "desc",
      status: "DISCOVERED",
      source: "intern-list",
      verificationStatus: "ACTIVE_SOURCE_LISTED",
      url: "https://careers.teststrategyco.example/apply/1",
      officialApplyUrl: "https://careers.teststrategyco.example/apply/1",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      ...overrides,
    },
  });
}

async function makeResume(jobId: string, tailoringStatus: string, documentFingerprint: string | null = null) {
  return prisma.generatedDocument.create({
    data: {
      userId,
      jobId,
      type: "resume",
      version: 1,
      storagePath: `data/generated/${userId}/${jobId}/resume-v1.pdf`,
      qaStatus: "pass",
      tailoringStatus,
      identityVerified: true,
      bulletIdsUsed: "[]",
      documentFingerprint,
    },
  });
}

async function cleanup() {
  await prisma.applicationRun.deleteMany({ where: { job: { company: "Test Strategy Co" } } });
  await prisma.generatedDocument.deleteMany({ where: { job: { company: "Test Strategy Co" } } });
  await prisma.userJobState.deleteMany({ where: { job: { company: "Test Strategy Co" } } });
  await prisma.job.deleteMany({ where: { company: "Test Strategy Co" } });
  await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
}

async function main() {
  await cleanup();
  const user = await prisma.user.create({ data: { email: TEST_EMAIL, name: "Document Strategy Audit" } });
  userId = user.id;
  await setApplicationMode(userId, "FILL_TO_SUBMIT");

  console.log("1) jobDescriptionCompleteness classification");
  check(jobDescriptionCompleteness(COMPLETE) === "complete", "complete description → complete");
  check(jobDescriptionCompleteness(PARTIAL) === "partial", "partial description → partial");
  check(jobDescriptionCompleteness(NONE) === "none", "no description → none");

  console.log("\n2) tailoringStatusForCompleteness mapping");
  check(tailoringStatusForCompleteness("complete", "TAILORED_WITH_SUPPORTED_CHANGES") === "TAILORED_WITH_SUPPORTED_CHANGES", "complete keeps audit status");
  check(tailoringStatusForCompleteness("partial", "X") === "PARTIAL_TAILORING", "partial → PARTIAL_TAILORING");
  check(tailoringStatusForCompleteness("none", "X") === "MASTER_RESUME_FALLBACK", "none → MASTER_RESUME_FALLBACK");

  console.log("\n3) legacy NOT_TAILORED resume is a USABLE master fallback (not a blocker)");
  check(strategyFromTailoringStatus("NOT_TAILORED_NO_JOB_DESCRIPTION") === "MASTER_RESUME_FALLBACK", "NOT_TAILORED → MASTER_RESUME_FALLBACK");
  check(isUsableResume({ type: "resume", qaStatus: "pass", identityVerified: true }), "qa-passed identity-verified resume is usable regardless of tailoring");

  console.log("\n4) A job whose only resume is a master fallback still queues (no NOT_TAILORED block)");
  const jobFallback = await makeJob(NONE);
  await makeResume(jobFallback.id, "MASTER_RESUME_FALLBACK");
  try {
    const res = await enqueueApplication(jobFallback.id, userId);
    check(res.queued === true, "run queued with a master-fallback resume");
    const run = await prisma.applicationRun.findFirst({ where: { id: res.runId, userId } });
    check(run?.documentStrategy === "EXISTING_APPROVED_DOCUMENT", `documentStrategy recorded (got ${run?.documentStrategy})`);
    check(run?.jobDescriptionCompleteness === "none", `completeness recorded (got ${run?.jobDescriptionCompleteness})`);
    check(!!run?.resumeDocumentId, "a resume document was attached");
  } catch (err) {
    check(false, `should not throw, but threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("\n5) legacy NOT_TAILORED resume is also accepted (retryable jobs)");
  const jobLegacy = await makeJob({ ...NONE, company: "Test Strategy Co", title: "Legacy Intern" });
  await makeResume(jobLegacy.id, "NOT_TAILORED_NO_JOB_DESCRIPTION");
  try {
    const res = await enqueueApplication(jobLegacy.id, userId);
    check(res.queued === true || res.status === "queued", "run queued with a legacy NOT_TAILORED resume");
  } catch (err) {
    check(false, `legacy resume should be usable, threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("\n6a) A CURRENT fingerprint-matched TAILORED résumé is reused directly");
  const jobCurrent = await makeJob({ ...COMPLETE, title: "Current Fingerprint Intern" });
  const currentFingerprint = await computeDocumentFingerprint(jobCurrent.id, userId);
  await makeResume(jobCurrent.id, "TAILORED_WITH_SUPPORTED_CHANGES", currentFingerprint);
  try {
    const res = await enqueueApplication(jobCurrent.id, userId);
    check(res.queued === true, "run queued using the current fingerprint-matched résumé");
    const run = await prisma.applicationRun.findFirst({ where: { id: res.runId, userId } });
    check(run?.documentStrategy === "EXISTING_APPROVED_DOCUMENT", `documentStrategy recorded (got ${run?.documentStrategy})`);
    const usedDoc = await prisma.generatedDocument.findUnique({ where: { id: run?.resumeDocumentId ?? "" } });
    check(usedDoc?.documentFingerprint === currentFingerprint, "the fingerprint-matched résumé (not a regenerated one) was attached");
  } catch (err) {
    check(false, `should not throw, but threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("\n6b) REGRESSION: a stale TAILORED résumé (fingerprint mismatch) is never reused as current");
  // A TAILORED résumé whose stored fingerprint does not match the job's
  // CURRENT fingerprint must not be silently treated as current just because
  // it is QA-passed and identity-verified — those checks say the file is
  // sound, not that its content still matches today's job/profile/JD. With
  // no AI match on this fixture job, deterministic regeneration cannot
  // happen either, so the correct outcome is: the stale TAILORED doc is
  // ignored, and since no MASTER_RESUME_FALLBACK document exists, the run is
  // blocked with NO_APPROVED_DOCUMENT rather than silently uploading stale
  // tailored content.
  const jobStale = await makeJob({ ...COMPLETE, title: "Stale Fingerprint Intern" });
  await makeResume(jobStale.id, "TAILORED_WITH_SUPPORTED_CHANGES", "stale-fingerprint-from-a-different-jd");
  try {
    await enqueueApplication(jobStale.id, userId);
    check(false, "should have thrown NO_APPROVED_DOCUMENT for a stale-fingerprint-only resume");
  } catch (err) {
    check(
      err instanceof ApplicationAgentError && /No approved resume exists/i.test(err.message),
      `stale TAILORED doc rejected, blocked with NO_APPROVED_DOCUMENT (got: ${err instanceof Error ? err.message : String(err)})`,
    );
  }

  console.log("\n6c) A stale TAILORED résumé alongside a valid MASTER_RESUME_FALLBACK still queues safely");
  const jobStaleWithFallback = await makeJob({ ...COMPLETE, title: "Stale Plus Fallback Intern" });
  await makeResume(jobStaleWithFallback.id, "TAILORED_WITH_SUPPORTED_CHANGES", "stale-fingerprint-from-a-different-jd");
  await makeResume(jobStaleWithFallback.id, "MASTER_RESUME_FALLBACK");
  try {
    const res = await enqueueApplication(jobStaleWithFallback.id, userId);
    check(res.queued === true, "run queued using the master-fallback resume, not the stale TAILORED one");
    const run = await prisma.applicationRun.findFirst({ where: { id: res.runId, userId } });
    const usedDoc = await prisma.generatedDocument.findUnique({ where: { id: run?.resumeDocumentId ?? "" } });
    check(usedDoc?.tailoringStatus === "MASTER_RESUME_FALLBACK", `used the master-fallback document, not the stale TAILORED one (got tailoringStatus=${usedDoc?.tailoringStatus})`);
  } catch (err) {
    check(false, `should not throw, but threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("\n6d) A CURRENT fingerprint-matched résumé that failed QA is never reused");
  const jobQaFailed = await makeJob({ ...COMPLETE, title: "QA Failed Intern" });
  const qaFailedFingerprint = await computeDocumentFingerprint(jobQaFailed.id, userId);
  await prisma.generatedDocument.create({
    data: {
      userId,
      jobId: jobQaFailed.id,
      type: "resume",
      version: 1,
      storagePath: `data/generated/${userId}/${jobQaFailed.id}/resume-v1.pdf`,
      qaStatus: "fail",
      tailoringStatus: "TAILORED_WITH_SUPPORTED_CHANGES",
      identityVerified: true,
      bulletIdsUsed: "[]",
      documentFingerprint: qaFailedFingerprint,
    },
  });
  try {
    await enqueueApplication(jobQaFailed.id, userId);
    check(false, "should have thrown NO_APPROVED_DOCUMENT for a QA-failed résumé");
  } catch (err) {
    check(
      err instanceof ApplicationAgentError && /No approved resume exists/i.test(err.message),
      `QA-failed résumé rejected, blocked with NO_APPROVED_DOCUMENT (got: ${err instanceof Error ? err.message : String(err)})`,
    );
  }

  console.log("\n6e) A résumé generated for a DIFFERENT job is never reused for this job");
  const jobWrongOwner = await makeJob({ ...COMPLETE, title: "Wrong Job Owner Intern" });
  const jobTarget = await makeJob({ ...COMPLETE, title: "Wrong Job Target Intern" });
  const wrongOwnerFingerprint = await computeDocumentFingerprint(jobWrongOwner.id, userId);
  await makeResume(jobWrongOwner.id, "TAILORED_WITH_SUPPORTED_CHANGES", wrongOwnerFingerprint);
  try {
    await enqueueApplication(jobTarget.id, userId);
    check(false, "should have thrown NO_APPROVED_DOCUMENT rather than reusing another job's résumé");
  } catch (err) {
    check(
      err instanceof ApplicationAgentError && /No approved resume exists/i.test(err.message),
      `wrong-job résumé never reused (got: ${err instanceof Error ? err.message : String(err)})`,
    );
  }

  console.log("\n6) A job with NO approved resume blocks with NO_APPROVED_DOCUMENT");
  const jobNoDoc = await makeJob({ title: "No Doc Intern" });
  try {
    await enqueueApplication(jobNoDoc.id, userId);
    check(false, "should have thrown NO_APPROVED_DOCUMENT");
  } catch (err) {
    check(err instanceof ApplicationAgentError && /No approved resume exists/i.test(err.message), `blocked with NO_APPROVED_DOCUMENT message (got: ${err instanceof Error ? err.message : String(err)})`);
  }

  await cleanup();
  console.log(failures === 0 ? "\nAll document-strategy tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => { console.error("Document-strategy test crashed:", e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
