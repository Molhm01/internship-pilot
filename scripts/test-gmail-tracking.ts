import "dotenv/config";
import { prisma } from "@/lib/db";
import { processEmail, applyProcessedEmail } from "@/lib/gmail/sync";
import { loadJobMatchCandidates } from "@/lib/gmail/matchJob";
import type { FetchedEmail } from "@/lib/gmail/client";

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

const TEST_COMPANY_PREFIX = "Gmail Test Co";

async function makeTestJob(opts: { title: string; company: string; status: string; requisitionId?: string }) {
  return prisma.job.create({
    data: {
      title: opts.title,
      company: opts.company,
      description: "Fixture job for Gmail tracking tests.",
      status: opts.status,
      source: "manual",
      requisitionId: opts.requisitionId ?? null,
      verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
      verificationMethod: "manual-entry",
    },
  });
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

async function cleanup() {
  const jobs = await prisma.job.findMany({ where: { company: { startsWith: TEST_COMPANY_PREFIX } } });
  for (const j of jobs) {
    await prisma.trackedEmail.deleteMany({ where: { matchedJobId: j.id } });
    await prisma.assessmentInboxEntry.deleteMany({ where: { jobId: j.id } });
    await prisma.job.delete({ where: { id: j.id } });
  }
}

async function main() {
  await cleanup();

  console.log("1) Confirmation email is classified and updates tracker status");
  {
    const company = `${TEST_COMPANY_PREFIX} Confirm`;
    const job = await makeTestJob({ title: "Systems Engineering Intern", company, status: "READY_TO_APPLY" });
    const email = fixtureEmail({
      subject: `Your application to ${company}`,
      fromAddress: "careers@example-employer.com",
      bodyText: `Thank you for applying to the Systems Engineering Intern position at ${company}. We have received your application and will be in touch.`,
    });
    const candidates = await loadJobMatchCandidates();
    const result = await processEmail(email, candidates);
    check(result.classification.classification === "confirmation", `classified as confirmation (got ${result.classification.classification})`);
    check(result.matchedJobId === job.id, "matched to the correct job");
    check(result.statusApplied === "SUBMITTED", `status update is SUBMITTED (got ${result.statusApplied})`);
    await applyProcessedEmail(email, result);
    const updated = await prisma.job.findUnique({ where: { id: job.id } });
    check(updated?.status === "SUBMITTED", `job status actually became SUBMITTED (got ${updated?.status})`);
  }

  console.log("\n2) Assessment email extracts only explicitly-stated details, never invents them");
  {
    const company = `${TEST_COMPANY_PREFIX} Assess`;
    const job = await makeTestJob({ title: "Hardware Intern", company, status: "SUBMITTED" });
    const email = fixtureEmail({
      subject: `Next steps: ${company} coding assessment`,
      fromAddress: "recruiting@example-employer.com",
      bodyText: `Congratulations on advancing! Please complete our HackerRank coding assessment within 5 days of receiving this email. The assessment should take about 90 minutes. Start here: https://hackerrank.com/test/abc123`,
    });
    const candidates = await loadJobMatchCandidates();
    const result = await processEmail(email, candidates);
    check(result.classification.classification === "assessment", `classified as assessment (got ${result.classification.classification})`);
    check(result.statusApplied === "ASSESSMENT_REQUIRED", `status update is ASSESSMENT_REQUIRED (got ${result.statusApplied})`);
    check(result.classification.assessment?.provider?.toLowerCase().includes("hackerrank") ?? false, `provider extracted correctly (got ${result.classification.assessment?.provider})`);
    check(!!result.classification.assessment?.link?.includes("hackerrank.com"), `link extracted correctly (got ${result.classification.assessment?.link})`);
    await applyProcessedEmail(email, result);
    const entry = await prisma.assessmentInboxEntry.findFirst({ where: { jobId: job.id } });
    check(!!entry, "AssessmentInboxEntry was created");
    check(entry?.deadline === null, "deadline field stays null (raw date is never computed/invented)");
  }

  console.log("\n3) Rejection always applies, even overriding a forward status");
  {
    const company = `${TEST_COMPANY_PREFIX} Reject`;
    await makeTestJob({ title: "Controls Intern", company, status: "INTERVIEW" });
    const email = fixtureEmail({
      subject: `Update on your application to ${company}`,
      fromAddress: "careers@example-employer.com",
      bodyText: `Thank you for interviewing for the Controls Intern role at ${company}. After careful consideration, we have decided to move forward with other candidates at this time.`,
    });
    const candidates = await loadJobMatchCandidates();
    const result = await processEmail(email, candidates);
    check(result.classification.classification === "rejection", `classified as rejection (got ${result.classification.classification})`);
    check(result.statusApplied === "REJECTED", `status update is REJECTED (got ${result.statusApplied})`);
  }

  console.log("\n4) A stale confirmation email never regresses a job that's already further along");
  {
    const company = `${TEST_COMPANY_PREFIX} NoRegress`;
    const job = await makeTestJob({ title: "Firmware Intern", company, status: "INTERVIEW" });
    const email = fixtureEmail({
      subject: `Your application to ${company}`,
      fromAddress: "careers@example-employer.com",
      bodyText: `Thank you for applying to the Firmware Intern position at ${company}. We have received your application.`,
    });
    const candidates = await loadJobMatchCandidates();
    const result = await processEmail(email, candidates);
    check(result.statusApplied === null, `no status regression applied (got ${result.statusApplied})`);
    await applyProcessedEmail(email, result);
    const updated = await prisma.job.findUnique({ where: { id: job.id } });
    check(updated?.status === "INTERVIEW", `job status remains INTERVIEW (got ${updated?.status})`);
  }

  console.log("\n5) An email that matches no tracked job is still recorded, with no crash");
  {
    const email = fixtureEmail({
      subject: "Totally Unrelated Company — thanks for reaching out",
      fromAddress: "noreply@totally-unrelated-company.example",
      bodyText: "This email has nothing to do with any job you're tracking.",
    });
    const candidates = await loadJobMatchCandidates();
    const result = await processEmail(email, candidates);
    check(result.matchedJobId === null, "no job matched");
    await applyProcessedEmail(email, result);
    const tracked = await prisma.trackedEmail.findUnique({ where: { gmailMessageId: email.gmailMessageId } });
    check(!!tracked, "email was still saved to TrackedEmail for visibility");
    await prisma.trackedEmail.delete({ where: { gmailMessageId: email.gmailMessageId } });
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
