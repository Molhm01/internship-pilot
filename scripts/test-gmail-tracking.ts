import "dotenv/config";
import { prisma } from "@/lib/db";
import { processEmail, applyProcessedEmail } from "@/lib/gmail/sync";
import { loadJobMatchCandidates } from "@/lib/gmail/matchJob";
import type { EmailClassificationResult } from "@/lib/gmail/classify";
import type { FetchedEmail } from "@/lib/gmail/client";

let failures = 0;
const TEST_COMPANY_PREFIX = "Gmail Test Co";
const TEST_EMAIL = "gmail-tracking-audit@example.test";
let userId = "";

function check(condition: boolean, message: string) {
  if (condition) console.log(`  PASS: ${message}`);
  else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

async function makeTestJob(opts: { title: string; company: string; status: string; requisitionId?: string }) {
  const job = await prisma.job.create({
    data: {
      title: opts.title,
      company: opts.company,
      description: "Fixture job for Gmail tracking tests.",
      status: "DISCOVERED",
      source: "manual",
      requisitionId: opts.requisitionId ?? null,
      verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
      verificationMethod: "manual-entry",
    },
  });
  await prisma.userJobState.create({
    data: { userId, jobId: job.id, applicationStatus: opts.status },
  });
  return job;
}

function fixtureEmail(overrides: Partial<FetchedEmail>): FetchedEmail {
  return {
    gmailMessageId: `msg-${Math.random().toString(36).slice(2)}`,
    threadId: "thread-1",
    subject: "",
    fromAddress: "",
    snippet: "",
    bodyText: "",
    receivedAt: new Date(),
    ...overrides,
  };
}

/**
 * CI contract classifier. This is deliberately deterministic: it validates the
 * tracker/matching/persistence logic without pretending GitHub Actions has the
 * user's local Ollama model. Real Ollama classification remains covered by the
 * separate local integration diagnostic.
 */
async function fixtureClassifier(email: { subject: string; bodyText: string }): Promise<EmailClassificationResult> {
  const text = `${email.subject}\n${email.bodyText}`.toLowerCase();
  if (text.includes("hackerrank") || text.includes("assessment")) {
    const link = email.bodyText.match(/https?:\/\/\S+/)?.[0] ?? null;
    return {
      classification: "assessment",
      company: text.match(/gmail test co[^\n.]*/i)?.[0] ?? null,
      jobTitle: null,
      assessment: {
        provider: text.includes("hackerrank") ? "HackerRank" : null,
        deadline: text.includes("within 5 days") ? "within 5 days of receiving this email" : null,
        duration: text.includes("90 minutes") ? "90 minutes" : null,
        link,
        instructions: "Complete the explicitly requested assessment.",
      },
    };
  }
  if (text.includes("move forward with other candidates") || text.includes("rejection")) {
    return { classification: "rejection", company: null, jobTitle: null, assessment: null };
  }
  if (text.includes("received your application") || text.includes("thank you for applying")) {
    return { classification: "confirmation", company: null, jobTitle: null, assessment: null };
  }
  return { classification: "unknown", company: null, jobTitle: null, assessment: null };
}

async function cleanup() {
  const jobs = await prisma.job.findMany({ where: { company: { startsWith: TEST_COMPANY_PREFIX } } });
  for (const j of jobs) {
    await prisma.trackedEmail.deleteMany({ where: { matchedJobId: j.id } });
    await prisma.assessmentInboxEntry.deleteMany({ where: { jobId: j.id } });
    await prisma.userJobState.deleteMany({ where: { jobId: j.id } });
    await prisma.job.delete({ where: { id: j.id } });
  }
  await prisma.trackedEmail.deleteMany({ where: { user: { email: TEST_EMAIL } } });
  await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
}

async function currentStatus(jobId: string) {
  const state = await prisma.userJobState.findUnique({ where: { userId_jobId: { userId, jobId } } });
  return state?.applicationStatus ?? null;
}

async function main() {
  await cleanup();
  const user = await prisma.user.create({ data: { email: TEST_EMAIL, name: "Gmail Tracking Audit" } });
  userId = user.id;

  console.log("1) Confirmation email is classified and updates only this user's tracker status");
  {
    const company = `${TEST_COMPANY_PREFIX} Confirm`;
    const job = await makeTestJob({ title: "Systems Engineering Intern", company, status: "READY_TO_APPLY" });
    const email = fixtureEmail({
      subject: `Your application to ${company}`,
      fromAddress: "careers@example-employer.com",
      bodyText: `Thank you for applying to the Systems Engineering Intern position at ${company}. We have received your application and will be in touch.`,
    });
    const candidates = await loadJobMatchCandidates(userId);
    const result = await processEmail(email, candidates, userId, fixtureClassifier);
    check(result.classification.classification === "confirmation", `classified as confirmation (got ${result.classification.classification})`);
    check(result.matchedJobId === job.id, "matched to the correct job");
    check(result.statusApplied === "SUBMITTED", `status update is SUBMITTED (got ${result.statusApplied})`);
    await applyProcessedEmail(email, result, userId);
    check((await currentStatus(job.id)) === "SUBMITTED", "user tracker status became SUBMITTED");
    const shared = await prisma.job.findUnique({ where: { id: job.id } });
    check(shared?.status === "DISCOVERED", "shared Job.status remains unchanged");
  }

  console.log("\n2) Assessment email extracts only explicitly-stated details, never invents a Date");
  {
    const company = `${TEST_COMPANY_PREFIX} Assess`;
    const job = await makeTestJob({ title: "Hardware Intern", company, status: "SUBMITTED" });
    const email = fixtureEmail({
      subject: `Next steps: ${company} coding assessment`,
      fromAddress: "recruiting@example-employer.com",
      bodyText: "Congratulations on advancing! Please complete our HackerRank coding assessment within 5 days of receiving this email. The assessment should take about 90 minutes. Start here: https://hackerrank.com/test/abc123",
    });
    const candidates = await loadJobMatchCandidates(userId);
    const result = await processEmail(email, candidates, userId, fixtureClassifier);
    check(result.classification.classification === "assessment", `classified as assessment (got ${result.classification.classification})`);
    check(result.statusApplied === "ASSESSMENT_REQUIRED", `status update is ASSESSMENT_REQUIRED (got ${result.statusApplied})`);
    check(result.classification.assessment?.provider === "HackerRank", `provider extracted correctly (got ${result.classification.assessment?.provider})`);
    check(!!result.classification.assessment?.link?.includes("hackerrank.com"), `link extracted correctly (got ${result.classification.assessment?.link})`);
    await applyProcessedEmail(email, result, userId);
    const entry = await prisma.assessmentInboxEntry.findFirst({ where: { jobId: job.id, userId } });
    check(!!entry, "AssessmentInboxEntry was created for the owner");
    check(entry?.deadline === null, "deadline Date stays null; raw relative text is never converted/invented");
  }

  console.log("\n3) Rejection always applies, even overriding a forward status");
  {
    const company = `${TEST_COMPANY_PREFIX} Reject`;
    const job = await makeTestJob({ title: "Controls Intern", company, status: "INTERVIEW" });
    const email = fixtureEmail({
      subject: `Update on your application to ${company}`,
      fromAddress: "careers@example-employer.com",
      bodyText: `Thank you for interviewing for the Controls Intern role at ${company}. After careful consideration, we have decided to move forward with other candidates at this time.`,
    });
    const candidates = await loadJobMatchCandidates(userId);
    const result = await processEmail(email, candidates, userId, fixtureClassifier);
    check(result.classification.classification === "rejection", `classified as rejection (got ${result.classification.classification})`);
    check(result.statusApplied === "REJECTED", `status update is REJECTED (got ${result.statusApplied})`);
    await applyProcessedEmail(email, result, userId);
    check((await currentStatus(job.id)) === "REJECTED", "owner tracker became REJECTED");
  }

  console.log("\n4) A stale confirmation never regresses this user's later tracker state");
  {
    const company = `${TEST_COMPANY_PREFIX} NoRegress`;
    const job = await makeTestJob({ title: "Firmware Intern", company, status: "INTERVIEW" });
    const email = fixtureEmail({
      subject: `Your application to ${company}`,
      fromAddress: "careers@example-employer.com",
      bodyText: `Thank you for applying to the Firmware Intern position at ${company}. We have received your application.`,
    });
    const candidates = await loadJobMatchCandidates(userId);
    const result = await processEmail(email, candidates, userId, fixtureClassifier);
    check(result.statusApplied === null, `no status regression applied (got ${result.statusApplied})`);
    await applyProcessedEmail(email, result, userId);
    check((await currentStatus(job.id)) === "INTERVIEW", "owner tracker remains INTERVIEW");
  }

  console.log("\n5) An email that matches no tracked job is still recorded, with no crash");
  {
    const email = fixtureEmail({
      subject: "Totally Unrelated Company — thanks for reaching out",
      fromAddress: "noreply@totally-unrelated-company.example",
      bodyText: "This email has nothing to do with any job you're tracking.",
    });
    const candidates = await loadJobMatchCandidates(userId);
    const result = await processEmail(email, candidates, userId, fixtureClassifier);
    check(result.matchedJobId === null, "no job matched");
    await applyProcessedEmail(email, result, userId);
    const tracked = await prisma.trackedEmail.findUnique({ where: { userId_gmailMessageId: { userId, gmailMessageId: email.gmailMessageId } } });
    check(!!tracked, "email was still saved for this user");
    await prisma.trackedEmail.delete({ where: { userId_gmailMessageId: { userId, gmailMessageId: email.gmailMessageId } } });
  }

  console.log("\n6) Cleanup");
  await cleanup();
  console.log("  done");

  console.log(failures === 0 ? "\nAll Gmail-tracking tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Gmail tracking test crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
