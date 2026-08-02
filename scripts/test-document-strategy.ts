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

let failures = 0;
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

async function makeResume(jobId: string, tailoringStatus: string) {
  return prisma.generatedDocument.create({
    data: { jobId, type: "resume", version: 1, storagePath: `data/generated/${jobId}/resume-v1.pdf`, qaStatus: "pass", tailoringStatus, identityVerified: true, bulletIdsUsed: "[]" },
  });
}

async function cleanup() {
  await prisma.applicationRun.deleteMany({ where: { job: { company: "Test Strategy Co" } } });
  await prisma.generatedDocument.deleteMany({ where: { job: { company: "Test Strategy Co" } } });
  await prisma.job.deleteMany({ where: { company: "Test Strategy Co" } });
}

async function main() {
  await setApplicationMode("FILL_TO_SUBMIT");
  await cleanup();

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
    const res = await enqueueApplication(jobFallback.id);
    check(res.queued === true, "run queued with a master-fallback resume");
    const run = await prisma.applicationRun.findUnique({ where: { id: res.runId } });
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
    const res = await enqueueApplication(jobLegacy.id);
    check(res.queued === true || res.status === "queued", "run queued with a legacy NOT_TAILORED resume");
  } catch (err) {
    check(false, `legacy resume should be usable, threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("\n6) A job with NO approved resume blocks with NO_APPROVED_DOCUMENT");
  const jobNoDoc = await makeJob({ title: "No Doc Intern" });
  try {
    await enqueueApplication(jobNoDoc.id);
    check(false, "should have thrown NO_APPROVED_DOCUMENT");
  } catch (err) {
    check(err instanceof ApplicationAgentError && /No approved resume exists/i.test(err.message), `blocked with NO_APPROVED_DOCUMENT message (got: ${err instanceof Error ? err.message : String(err)})`);
  }

  await cleanup();
  console.log(failures === 0 ? "\nAll document-strategy tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => { console.error("Document-strategy test crashed:", e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
