import "dotenv/config";
import path from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { prisma } from "@/lib/db";
import { normalizeQuestionText } from "@/lib/applications/approvedAnswers";
import { setApplicationMode } from "@/lib/applications/settings";
import { captureAndSaveOfficialJobDescription } from "@/lib/jobs/captureDescription";
import { generateDocumentsForJob } from "@/lib/documents/generate";
import { extractPdfText } from "@/lib/pdf";
import { validateDocumentIdentity } from "@/lib/documents/identityGuard";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is set by scripts/test-application-agent.ts; run that instead of this file.`);
  return value;
}

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
if (process.env.ISOLATED_TEST_MODE !== "1") throw new Error("Refusing to run mock identity tests without an isolated temporary database.");

// Everything this suite creates belongs to one signed-up account, and every
// request carries that account's session cookie. The server decides the owner
// from the cookie and never from a body or a header, so a fixture without one
// would only ever prove that unauthenticated requests are refused.
// The mock employer runs on its own origin so the fixture pages are reachable
// without an Internship Pilot session, exactly as a real employer page is.
const MOCK_ATS_BASE_URL = requiredEnv("MOCK_ATS_BASE_URL");
const TEST_USER_ID = requiredEnv("AGENT_TEST_USER_ID");
const TEST_SESSION_COOKIE = requiredEnv("AGENT_TEST_SESSION_COOKIE");

/** fetch, signed in as the fixture account. */
function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), cookie: TEST_SESSION_COOKIE },
  });
}
const TEST_COMPANY_PREFIX = "Application Worker Mock";
const TEST_SOURCE = "application-worker-test";
const testPort = 44_000 + (process.pid % 1_000);
const testTempRoot = requiredEnv("TEST_TEMP_ROOT");
const workerEnv = {
  ...process.env,
  APPLICATION_WORKER_TEST_ONLY: "1",
  APPLICATION_WORKER_PORT: String(testPort),
  APPLICATION_WORKER_LOCK_PATH: path.join(testTempRoot, "application-worker.lock.json"),
  APPLICATION_BROWSER_PROFILE_DIR: path.join(testTempRoot, "browser-profile"),
  DISABLE_VISION_AGENT: "1",
  FORCE_HEADLESS: "1",
};

let failures = 0;
let worker: ChildProcessWithoutNullStreams | null = null;


function check(condition: unknown, message: string): void {
  if (condition) console.log(`  PASS: ${message}`);
  else {
    console.error(`  FAIL: ${message}`);
    failures += 1;
  }
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  if (!predicate(value)) throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(value)}`);
  return value;
}

function startWorker(): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/application-worker.ts"], {
    cwd: process.cwd(),
    env: workerEnv,
    stdio: "pipe",
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`  [worker] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`  [worker] ${chunk}`));
  return child;
}

async function waitForWorkerReady(): Promise<void> {
  await waitFor(
    async () => fetch(`http://127.0.0.1:${testPort}/health`).then((response) => response.ok ? response.json() : null).catch(() => null),
    (health) => Boolean(
      health
      && typeof health === "object"
      && "browserReady" in health
      && "extensionReady" in health
      && health.browserReady
      && health.extensionReady,
    ),
    "test worker health",
  );
}

async function stopWorker(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
  ]);
}

async function removeConfirmedStaleTestLock(): Promise<void> {
  const relative = workerEnv.APPLICATION_WORKER_LOCK_PATH;
  const lockPath = path.resolve(process.cwd(), relative);
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
    if (typeof lock.pid !== "number") return;
    try {
      process.kill(lock.pid, 0);
      return;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EPERM") return;
    }
    await unlink(lockPath);
  } catch {
    // Missing/partially-created test locks need no cleanup action.
  }
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; output: string }> {
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, output };
}

async function makeDummyResume(candidate: { fullName: string; email: string; phone: string }): Promise<string> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(candidate.fullName, { x: 48, y: 740, size: 12, font });
  page.drawText(`${candidate.email} | ${candidate.phone}`, { x: 48, y: 720, size: 10, font });
  const outputPath = path.join(testTempRoot, "output", "resume.pdf");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, await pdf.save());
  return outputPath;
}

async function makeJob(title: string, fixture: string, resumePath: string) {
  const job = await prisma.job.create({
    data: {
      title,
      company: `${TEST_COMPANY_PREFIX} ${title}`,
      location: "Local mock",
      description: "Safe local mock application. No employer system is contacted.",
      status: "READY_TO_APPLY",
      source: TEST_SOURCE,
      url: `${MOCK_ATS_BASE_URL}/${fixture}`,
      verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
      verificationMethod: "local-mock",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      lastVerifiedAt: new Date(),
    },
  });
  await prisma.matchResult.create({
    data: {
      userId: TEST_USER_ID,
      jobId: job.id,
      eligibility: "Pass",
      eligibilityReason: "Safe mock test",
      score: 90,
      explanation: "Safe mock test",
      recommendation: "Apply",
      skillsSupported: "[]",
      skillsNeedConfirmation: "[]",
      skillsToLearn: "[]",
      skillsNeverAdd: "[]",
      factsUsed: "[]",
    },
  });
  await prisma.generatedDocument.create({
    data: { userId: TEST_USER_ID, jobId: job.id, type: "resume", storagePath: resumePath, qaStatus: "pass", qaIssues: "[]", identityVerified: true, tailoringStatus: "TAILORED_WITH_SUPPORTED_CHANGES" },
  });
  await prisma.generatedDocument.create({
    data: { userId: TEST_USER_ID, jobId: job.id, type: "coverLetter", storagePath: resumePath, qaStatus: "pass", qaIssues: "[]", identityVerified: true, tailoringStatus: "TAILORED_WITH_SUPPORTED_CHANGES" },
  });
  return job;
}

async function enqueue(jobId: string) {
  const response = await authedFetch(`${BASE_URL}/api/jobs/${jobId}/apply`, { method: "POST" });
  const body = await response.json();
  if (!response.ok) throw new Error(`Queue request failed (${response.status}): ${JSON.stringify(body)}`);
  return body as { runId: string; status: string; queued: boolean };
}

async function readRun(id: string) {
  return prisma.applicationRun.findUnique({ where: { id } });
}

async function workerHealth() {
  return fetch(`http://127.0.0.1:${testPort}/health`)
    .then((response) => response.ok ? response.json() as Promise<{
      browserReady: boolean;
      browserHealth: string;
      browserGeneration: number;
      processingRunId: string | null;
    }> : null)
    .catch(() => null);
}

async function workerTestAction(pathname: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${testPort}${pathname}`, { method: "POST" });
  if (!response.ok) throw new Error(`Worker test action ${pathname} failed (${response.status}): ${await response.text()}`);
}

async function cleanup(): Promise<void> {
  const jobs = await prisma.job.findMany({ where: { company: { startsWith: TEST_COMPANY_PREFIX } } });
  for (const job of jobs) await prisma.job.delete({ where: { id: job.id } });
}

async function main(): Promise<void> {
  const fixtures = JSON.parse(await readFile(path.join(process.cwd(), "scripts", "fixtures", "mock-candidates.json"), "utf8")) as {
    applicationAgent: { fullName: string; email: string; phone: string; school: string };
    browserUploadSafe: { fullName: string; email: string; phone: string; school: string };
  };
  const candidate = fixtures.browserUploadSafe;
  await authedFetch(`${BASE_URL}/api/agent-diagnostics`).catch(() => {
    throw new Error(`The local web server must be running at ${BASE_URL}.`);
  });
  await cleanup();
  await setApplicationMode(TEST_USER_ID, "FILL_TO_SUBMIT");
  // "Country" must be unanswerable so section 3 can prove the agent pauses on
  // it rather than inventing a value. Scoped to this account's bank.
  await prisma.approvedAnswer.deleteMany({ where: { userId: TEST_USER_ID, questionText: normalizeQuestionText("Country*") } });
  // The identity the agent is allowed to state, in the models that own it. The
  // country of residence is deliberately absent.
  const [first, ...restOfName] = candidate.fullName.split(" ");
  await prisma.userProfile.update({
    where: { userId: TEST_USER_ID },
    data: {
      legalFirstName: first ?? candidate.fullName,
      legalLastName: restOfName.join(" ") || candidate.fullName,
      applicationEmail: candidate.email,
      phone: candidate.phone,
      city: "Clifton",
      state: "NJ",
      country: null,
      linkedinUrl: "https://www.linkedin.com/in/application-worker-test/",
    },
  });
  await prisma.applicationPreferences.update({
    where: { userId: TEST_USER_ID },
    data: { legallyAuthorizedToWork: true, requiresSponsorshipNow: false },
  });
  await prisma.education.updateMany({ where: { userId: TEST_USER_ID }, data: { school: candidate.school } });
  const resumePath = await makeDummyResume(candidate);

  console.log("0) Complete job-description capture and evidence-grounded tailoring");
  const blockedFixture = fixtures.applicationAgent;
  check(validateDocumentIdentity(`${blockedFixture.fullName} ${blockedFixture.email} ${blockedFixture.phone}`, candidate).length > 0, "known mock identity is rejected by the PDF identity guard");
  const tailoringJob = await makeJob("Manufacturing Engineering Intern", "full-job-description.html", resumePath);
  await prisma.job.update({ where: { id: tailoringJob.id }, data: { company: `${TEST_COMPANY_PREFIX} Lightship` } });
  const captured = await captureAndSaveOfficialJobDescription(tailoringJob.id);
  check(captured.description.length >= 500 && captured.responsibilities.length > 0 && captured.qualifications.length > 0, "full description, responsibilities, and qualifications were captured");
  const generated = await generateDocumentsForJob(tailoringJob.id, TEST_USER_ID, { includeCoverLetter: false });
  const generatedResume = await prisma.generatedDocument.findUnique({ where: { id: generated.resume.id } });
  if (!generatedResume) throw new Error("Tailoring regression did not generate a resume.");
  const generatedText = (await extractPdfText(await readFile(generatedResume.storagePath))).text;
  // Two outcomes are correct here, and which one occurs depends on whether the
  // tailored substitutions still fit the one-page master format. Both are
  // usable; what must never happen is a résumé that claims what the applicant
  // cannot support, or no résumé at all.
  const tailored = generatedResume.tailoringStatus === "TAILORED_WITH_SUPPORTED_CHANGES";
  const fellBackToMaster = generatedResume.tailoringStatus === "MASTER_RESUME_FALLBACK";
  check(tailored || fellBackToMaster, `tailoring resolved to a usable outcome (got ${generatedResume.tailoringStatus})`);
  check(generatedResume.qaStatus === "pass", `the generated résumé passed QA (got ${generatedResume.qaStatus})`);
  check(generatedResume.identityVerified === true, "the generated résumé passed the identity guard");
  if (tailored) {
    check(
      /assembled 30\+ custom pcs/i.test(generatedText) && /ventilated enclosure integrating/i.test(generatedText),
      "supported Lightship alignment appears in the tailored PDF",
    );
  } else {
    console.log("  NOTE: the tailored résumé exceeded the one-page master format, so generation fell back to the untailored master. The unsupported-claim check below applies to that document.");
  }
  // The safety property is that tailoring never answers a requirement the
  // applicant has no evidence for. These are the ones the fixture posting
  // actually states and the profile does not support — time studies, work
  // instructions, line balancing, engineering drawings, the Google suite.
  //
  // It deliberately does not assert on "reliability testing", "equipment
  // calibration" or "ai": those sit in the master résumé's own Additional
  // skills group, entered by the applicant, and they are not requirements of
  // this posting. Per-posting claim correction removes such wording only when
  // the posting asks for it, which is the correct rule — the agent's job is to
  // avoid *adding* unsupported claims, not to edit the applicant's own résumé.
  const unsupportedByThisPosting = [
    /time stud/i,
    /line[- ]balanc/i,
    /work instructions/i,
    /engineering drawings/i,
    /google (?:software )?suite/i,
  ];
  const leaked = unsupportedByThisPosting.filter((pattern) => pattern.test(generatedText));
  check(leaked.length === 0, `no unsupported Lightship requirement entered the PDF${leaked.length ? ` (leaked: ${leaked.map(String).join(", ")})` : ""}`);

  console.log("1) Five Apply clicks create one durable queued run");
  const clickJob = await makeJob("Five Clicks", "greenhouse-fillonly.html", resumePath);
  const clicks = await Promise.all(Array.from({ length: 5 }, () => enqueue(clickJob.id)));
  check(new Set(clicks.map((result) => result.runId)).size === 1, "all five API responses returned the same run id");
  check(await prisma.applicationRun.count({ where: { jobId: clickJob.id } }) === 1, "five clicks created exactly one ApplicationRun");

  console.log("\n2) Two queued jobs are processed sequentially");
  const firstJob = await makeJob("Sequential One", "greenhouse-fillonly.html", resumePath);
  const secondJob = await makeJob("Sequential Two", "greenhouse-fillonly.html", resumePath);
  const firstQueued = await enqueue(firstJob.id);
  const secondQueued = await enqueue(secondJob.id);

  console.log("\n3) Unknown Country question pauses and resumes the same run");
  const countryJob = await makeJob("Country Pause", "greenhouse-country-review.html", resumePath);
  const countryQueued = await enqueue(countryJob.id);

  console.log("\n4) Lever multistep fill uploads both documents and stops at final review");
  const leverJob = await makeJob("Lever Multi Step", "lever-final-review-fillonly.html", resumePath);
  const leverQueued = await enqueue(leverJob.id);

  console.log("\n5) Lever legal questions pause without inventing an answer");
  const legalJob = await makeJob("Lever Legal Pause", "lever-multistep-fillonly.html", resumePath);
  const legalQueued = await enqueue(legalJob.id);

  console.log("\n6) Generic ARIA/React-style dropdown fills deterministically");
  const customJob = await makeJob("Generic Custom Dropdown", "generic-custom-dropdown.html", resumePath);
  const customQueued = await enqueue(customJob.id);

  console.log("\n7) CAPTCHA pauses the same run without attempting submission");
  const captchaJob = await makeJob("CAPTCHA Pause", "ashby-captcha.html", resumePath);
  const captchaQueued = await enqueue(captchaJob.id);

  worker = startWorker();
  await waitForWorkerReady();
  await waitFor(() => readRun(firstQueued.runId), (run) => run?.status === "filled", "first sequential job");
  await waitFor(() => readRun(secondQueued.runId), (run) => run?.status === "filled", "second sequential job");
  const [firstRun, secondRun] = await Promise.all([readRun(firstQueued.runId), readRun(secondQueued.runId)]);
  check(Boolean(firstRun?.finishedAt && secondRun?.startedAt && firstRun.finishedAt <= secondRun.startedAt), "job two started only after job one finished");

  const paused = await waitFor(() => readRun(countryQueued.runId), (run) => run?.status === "needs_user_action", "Country needs-action state");
  check(paused?.stoppedFieldLabel === "Country*", `exact question "Country*" is visible (got ${paused?.stoppedFieldLabel})`);
  check(paused?.stoppedFieldType === "select", "field type is stored");
  check(JSON.parse(paused?.stoppedFieldOptions ?? "[]").includes("United States"), "available options are stored");
  check(await prisma.applicationRun.count({ where: { jobId: countryJob.id } }) === 1, "Country created one needs-action run");

  const leverFilled = await waitFor(() => readRun(leverQueued.runId), (run) => run?.status === "filled", "Lever final review");
  const leverAnswers = JSON.parse(leverFilled?.answers ?? "{}") as Record<string, string>;
  check(leverFilled?.currentStep === "FINAL_REVIEW", "Lever reached final review");
  check(Boolean(leverAnswers["Resume/CV*"] && leverAnswers["Cover Letter"]), "Lever uploaded the resume and cover letter");
  check(!leverFilled?.confirmationNumber && leverFilled?.status !== "submitted", "Lever never clicked Submit");

  const legalPaused = await waitFor(() => readRun(legalQueued.runId), (run) => run?.status === "needs_user_action", "Lever legal-question pause");
  check(legalPaused?.needsUserActionReason === "citizenship_clearance_sponsorship_ambiguous", "work authorization was left for explicit user review");
  check(/eligible to work/i.test(legalPaused?.stoppedFieldLabel ?? ""), "the exact legal question is displayed");
  check(!legalPaused?.confirmationNumber && legalPaused?.status !== "submitted", "legal-question flow never clicked Submit");

  const customFilled = await waitFor(() => readRun(customQueued.runId), (run) => run?.status === "filled", "generic custom-dropdown final review");
  const customAnswers = JSON.parse(customFilled?.answers ?? "{}") as Record<string, string>;
  check(customAnswers["School*"] === candidate.school, "ARIA custom dropdown selected the grounded school option");
  check(customFilled?.currentStep === "FINAL_REVIEW" && customFilled.status !== "submitted", "generic fallback reached manual final review without Submit");

  const captchaPaused = await waitFor(() => readRun(captchaQueued.runId), (run) => run?.status === "needs_user_action", "CAPTCHA pause");
  check(captchaPaused?.id === captchaQueued.runId && captchaPaused.needsUserActionReason === "captcha", "CAPTCHA paused the original run");
  check(captchaPaused?.currentStep === "NEEDS_USER_ACTION" && captchaPaused.errorLog === null, "CAPTCHA is a pause, not a failed run");
  check(!captchaPaused?.confirmationNumber && captchaPaused?.status !== "submitted", "CAPTCHA flow never clicked Submit");
  check(
    captchaPaused?.stageHistory?.includes("Complete the CAPTCHA in the application browser, then click Resume."),
    "CAPTCHA pause stores the exact user instruction",
  );

  console.log("\n8) CAPTCHA Resume continues the retained same run");
  await workerTestAction(`/test/captcha/complete?runId=${encodeURIComponent(captchaQueued.runId)}`);
  const captchaResumeResponse = await authedFetch(`${BASE_URL}/api/applications/${captchaQueued.runId}/resume`, { method: "POST" });
  check(captchaResumeResponse.ok, "CAPTCHA Resume queued the existing run");
  const captchaCompleted = await waitFor(() => readRun(captchaQueued.runId), (run) => run?.status === "filled", "CAPTCHA same-page resume");
  check(captchaCompleted?.id === captchaQueued.runId && captchaCompleted.currentStep === "FINAL_REVIEW", "CAPTCHA Resume continued the same retained page to final review");
  check(await prisma.applicationRun.count({ where: { jobId: captchaJob.id } }) === 1, "CAPTCHA Resume created no duplicate run");

  console.log("\n9) Closing a CAPTCHA browser and resuming safely reopens the same application");
  const closedCaptchaJob = await makeJob("CAPTCHA Browser Closed", "ashby-captcha.html", resumePath);
  const closedCaptchaQueued = await enqueue(closedCaptchaJob.id);
  await waitFor(() => readRun(closedCaptchaQueued.runId), (run) => run?.status === "needs_user_action", "second CAPTCHA pause");
  await workerTestAction("/test/browser/close");
  const closedCaptchaResume = await authedFetch(`${BASE_URL}/api/applications/${closedCaptchaQueued.runId}/resume`, { method: "POST" });
  check(closedCaptchaResume.ok, "Resume accepted the same run after its browser closed");
  const captchaReopened = await waitFor(
    () => readRun(closedCaptchaQueued.runId),
    (run) => run?.status === "needs_user_action" && parseStageCount(run.stageHistory, "NEEDS_USER_ACTION") >= 2,
    "reopened CAPTCHA pause",
  );
  check(captchaReopened?.id === closedCaptchaQueued.runId && captchaReopened.needsUserActionReason === "captcha", "the reopened page paused again when CAPTCHA returned");
  check(await prisma.applicationRun.count({ where: { jobId: closedCaptchaJob.id } }) === 1, "browser-close Resume created no duplicate run");

  const extensionAudits = await prisma.auditLogEntry.count({ where: { action: "extension-page-autofill" } });
  check(extensionAudits >= 7, "worker runs were filled through the authenticated extension path");

  console.log("\n10) Browser closes between queued runs and relaunches for the next run");
  const beforeBetween = await workerHealth();
  await workerTestAction("/test/browser/close");
  const afterCloseJob = await makeJob("Closed Between Runs", "greenhouse-fillonly.html", resumePath);
  const afterCloseQueued = await enqueue(afterCloseJob.id);
  const afterCloseFilled = await waitFor(() => readRun(afterCloseQueued.runId), (run) => run?.status === "filled", "closed-between-runs recovery");
  const afterBetween = await workerHealth();
  check(afterCloseFilled?.currentStep === "FINAL_REVIEW", "the next run succeeded after Chromium closed");
  check(Boolean(beforeBetween && afterBetween && afterBetween.browserGeneration > beforeBetween.browserGeneration), "BrowserManager launched a new context generation");

  console.log("\n11) Browser closes immediately before newPage and recovers once");
  const beforeNewPage = await workerHealth();
  await workerTestAction("/test/browser/close-before-new-page");
  const immediateCloseJob = await makeJob("Closed Before New Page", "greenhouse-fillonly.html", resumePath);
  const immediateCloseQueued = await enqueue(immediateCloseJob.id);
  const immediateCloseFilled = await waitFor(() => readRun(immediateCloseQueued.runId), (run) => run?.status === "filled", "immediate newPage recovery");
  const afterNewPage = await workerHealth();
  check(immediateCloseFilled?.currentStep === "FINAL_REVIEW", "closed-before-newPage run reached final review");
  check(Boolean(beforeNewPage && afterNewPage && afterNewPage.browserGeneration > beforeNewPage.browserGeneration), "newPage recovery replaced the closed context");

  console.log("\n12) Browser crash during a run fails only that run; five Retry clicks reuse it");
  const crashJob = await makeJob("Crash During Run", "slow-greenhouse-fillonly.html", resumePath);
  const crashQueued = await enqueue(crashJob.id);
  await waitFor(() => readRun(crashQueued.runId), (run) => run?.status === "running" && run.currentStep === "NAVIGATING", "crash fixture navigation");
  await workerTestAction("/test/browser/close");
  const crashed = await waitFor(() => readRun(crashQueued.runId), (run) => run?.status === "failed", "crashed run failure");
  check(crashed?.currentStep === "FAILED" && crashed.stageHistory?.includes("BROWSER_RESTART_FAILED"), "browser crash recorded readable recovery failure detail");
  const retryResponses = await Promise.all(Array.from({ length: 5 }, () =>
    authedFetch(`${BASE_URL}/api/applications/${crashQueued.runId}/retry`, { method: "POST" }),
  ));
  check(retryResponses.every((response) => response.ok), "all five Retry requests were idempotent");
  const retried = await waitFor(() => readRun(crashQueued.runId), (run) => run?.status === "filled", "same-run crash retry");
  check(retried?.id === crashQueued.runId, "Retry recovered the original ApplicationRun");
  check(await prisma.applicationRun.count({ where: { jobId: crashJob.id } }) === 1, "five Retry clicks created no duplicate run");

  console.log("\n13) Extension rebuild triggers a clean BrowserManager restart");
  const beforeExtension = await workerHealth();
  await workerTestAction("/test/extension/rebuilt");
  const extensionRestartJob = await makeJob("Extension Rebuild Restart", "greenhouse-fillonly.html", resumePath);
  const extensionRestartQueued = await enqueue(extensionRestartJob.id);
  await waitFor(() => readRun(extensionRestartQueued.runId), (run) => run?.status === "filled", "extension-rebuild recovery");
  const afterExtension = await workerHealth();
  check(Boolean(beforeExtension && afterExtension && afterExtension.browserGeneration > beforeExtension.browserGeneration), "new extension package caused a clean context generation");
  check(afterExtension?.browserHealth === "healthy" && afterExtension.browserReady, "BrowserManager is healthy after extension reload");

  console.log("\n14) INVALID_TEST_DATA is never selected or uploaded");
  const invalidJob = await makeJob("Invalid Document Guard", "greenhouse-fillonly.html", resumePath);
  const invalidDocument = await prisma.generatedDocument.create({
    data: {
      userId: TEST_USER_ID,
      jobId: invalidJob.id,
      type: "resume",
      version: 99,
      storagePath: path.join(testTempRoot, "missing-invalid-test-document.pdf"),
      qaStatus: "INVALID_TEST_DATA",
      qaIssues: JSON.stringify(["QA_INVALID_TEST_DATA"]),
      identityVerified: false,
      tailoringStatus: "TAILORED_WITH_SUPPORTED_CHANGES",
    },
  });
  const invalidQueued = await enqueue(invalidJob.id);
  const invalidSelectedRun = await readRun(invalidQueued.runId);
  check(invalidSelectedRun?.resumeDocumentId !== invalidDocument.id, "queue ignored the newest INVALID_TEST_DATA resume");
  const invalidGuardFilled = await waitFor(() => readRun(invalidQueued.runId), (run) => run?.status === "filled", "valid-document fallback final review");
  check(invalidGuardFilled?.status === "filled" && !invalidGuardFilled.confirmationNumber, "only the valid job-specific document was used and Submit was not clicked");

  console.log("\n15) A duplicate worker cannot acquire the lock or browser profile");
  const collisionWorker = startWorker();
  const collision = await waitForExit(collisionWorker);
  check(collision.code === 73, `duplicate worker exited with collision code 73 (got ${collision.code})`);
  check(/already running|lock is held/i.test(collision.output), "duplicate worker reported the existing owner instead of launching Chromium");
  await waitForWorkerReady();

  const answerResponse = await authedFetch(`${BASE_URL}/api/applications/${countryQueued.runId}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answer: "United States", reuse: true }),
  });
  const answerResult = await answerResponse.json() as { runId?: string; status?: string };
  check(answerResponse.ok && answerResult.runId === countryQueued.runId, "Save & retry queued the same run id");
  const completedCountry = await waitFor(() => readRun(countryQueued.runId), (run) => run?.status === "filled", "Country resumed final review");
  check(await prisma.applicationRun.count({ where: { jobId: countryJob.id } }) === 1, "resume created no duplicate run");
  check(completedCountry?.currentStep === "FINAL_REVIEW", "agent reached final review");
  check(completedCountry?.needsUserActionReason === null && completedCountry?.stoppedFieldLabel === null, "the normalized Country question was not asked again");
  check(!completedCountry?.confirmationNumber && completedCountry?.status !== "submitted", "Submit was never clicked");

  console.log("\n16) Worker restart recovers an interrupted run");
  await stopWorker(worker);
  worker = null;
  const recoveryJob = await makeJob("Restart Recovery", "greenhouse-fillonly.html", resumePath);
  const recoveryQueued = await enqueue(recoveryJob.id);
  await prisma.applicationRun.update({
    where: { id: recoveryQueued.runId },
    data: { status: "running", currentStep: "Simulated process interruption", startedAt: new Date() },
  });
  worker = startWorker();
  await waitForWorkerReady();
  const recovered = await waitFor(() => readRun(recoveryQueued.runId), (run) => run?.status === "filled", "restarted worker recovery");
  check(recovered?.id === recoveryQueued.runId, "restart recovered and finished the original run id");
  check(await prisma.applicationRun.count({ where: { jobId: recoveryJob.id } }) === 1, "restart recovery created no duplicate run");
  check(!recovered?.confirmationNumber && recovered?.status !== "submitted", "restart recovery never clicked Submit");

  console.log(failures === 0 ? "\nAll safe application-worker tests PASSED." : `\n${failures} safe application-worker test(s) FAILED.`);
  if (failures) process.exitCode = 1;
}

function parseStageCount(json: string | null, stage: string): number {
  if (!json) return 0;
  try {
    const entries = JSON.parse(json) as Array<{ stage?: string }>;
    return entries.filter((entry) => entry.stage === stage).length;
  } catch {
    return 0;
  }
}

main().catch((error) => {
  console.error("Safe application-worker test crashed:", error);
  process.exitCode = 1;
}).finally(async () => {
  await stopWorker(worker);
  await removeConfirmedStaleTestLock();
  await cleanup().catch(() => {});
  // Nothing to restore: the account, its profile and its answer bank are
  // created by scripts/test-application-agent.ts in a disposable database and
  // deleted by it afterwards.
  await prisma.$disconnect();
});
