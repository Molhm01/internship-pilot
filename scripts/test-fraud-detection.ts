import "dotenv/config";
import { prisma } from "@/lib/db";
import { scanTextForFraudSignals, checkJobForFraud } from "@/lib/sync/fraudCheck";

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

function hasReason(signals: { reason: string }[], reason: string): boolean {
  return signals.some((s) => s.reason === reason);
}

async function main() {
  console.log("1) Legitimate posting text produces zero fraud signals (no false positives)");
  const clean = scanTextForFraudSignals(
    "We are looking for an Electrical Engineering Intern to join our Reliability team for Summer 2027. Apply through our official careers page. Competitive pay and mentorship provided.",
  );
  check(clean.length === 0, `clean posting has no signals (got ${JSON.stringify(clean)})`);

  console.log("\n2) Payment/fee requests are detected");
  check(hasReason(scanTextForFraudSignals("A $50 application fee is required to process your application."), "requests-payment"), "application fee detected");
  check(hasReason(scanTextForFraudSignals("You must purchase a laptop from our approved vendor before starting."), "requests-payment"), "required equipment purchase detected");

  console.log("\n3) Cryptocurrency and gift-card requests are detected");
  check(hasReason(scanTextForFraudSignals("Please send a deposit via Bitcoin to confirm your spot."), "requests-cryptocurrency"), "cryptocurrency mention detected");
  check(hasReason(scanTextForFraudSignals("Purchase two $100 gift cards to cover onboarding materials."), "requests-gift-cards"), "gift card request detected");

  console.log("\n4) Banking and government ID requests are detected");
  check(hasReason(scanTextForFraudSignals("Please provide your bank account number and routing number to proceed."), "requests-banking-info"), "banking info request detected");
  check(hasReason(scanTextForFraudSignals("Please provide your social security number to begin the application."), "requests-government-id"), "SSN request detected");

  console.log("\n5) Unusual contact channels (Telegram/WhatsApp) are detected");
  check(hasReason(scanTextForFraudSignals("For questions, contact us on Telegram at @fakerecruiter."), "unusual-contact-channel"), "Telegram contact detected");

  console.log("\n6) A personal email address given as the contact channel is detected");
  const personalEmailSignals = scanTextForFraudSignals("If you have questions, please contact recruiter123@gmail.com for next steps.");
  check(hasReason(personalEmailSignals, "personal-email-contact"), `personal Gmail contact detected (got ${JSON.stringify(personalEmailSignals)})`);
  check(
    personalEmailSignals.some((s) => s.detail.includes("recruiter123@gmail.com")),
    `the FULL email address was extracted, not a truncated suffix (got ${JSON.stringify(personalEmailSignals)})`,
  );

  console.log("\n7) An executable download link is detected");
  check(hasReason(scanTextForFraudSignals("Download the onboarding tool here: https://example.com/setup.exe"), "executable-download"), "executable download link detected");

  console.log("\n8) checkJobForFraud actually quarantines the job in the database");
  const testJob = await prisma.job.create({
    data: {
      title: "Fraud Test Intern",
      company: "Fraud Test Co",
      description: "Send a $50 gift card to confirm your internship offer.",
      status: "DISCOVERED",
      source: "manual",
      verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
      verificationMethod: "manual-entry",
    },
  });
  const signals = await checkJobForFraud(testJob.id, [testJob.description]);
  check(signals.length > 0, "checkJobForFraud returned signal(s)");
  const updated = await prisma.job.findUnique({ where: { id: testJob.id } });
  check(updated?.verificationStatus === "SecurityQuarantine", `job moved to SecurityQuarantine status (got ${updated?.verificationStatus})`);
  const entries = await prisma.securityQuarantineEntry.findMany({ where: { jobId: testJob.id } });
  check(entries.length > 0, "SecurityQuarantineEntry row(s) created with reason/detail");
  await prisma.securityQuarantineEntry.deleteMany({ where: { jobId: testJob.id } });
  await prisma.job.delete({ where: { id: testJob.id } });

  console.log(failures === 0 ? "\nAll fraud-detection tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Fraud detection test crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
