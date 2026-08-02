import "dotenv/config";
import { prisma } from "@/lib/db";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

async function main() {
  console.log("1) Main Jobs feed = Active-feed policy (trusted sources OR verified; never quarantine/demo)");
  const res = await fetch(`${BASE_URL}/api/jobs`);
  const data = await res.json();
  check(Array.isArray(data.jobs) && data.jobs.length > 0, `jobs endpoint returned results (${data.jobs?.length})`);
  // Visibility is now decided by the central Active-feed policy, NOT by
  // requiring official verification: trusted-aggregator listings appear even
  // while verification is pending. But the feed must NEVER leak a
  // SecurityQuarantine job or a demo/fixture company.
  const noQuarantine = data.jobs.every((j: { verificationStatus: string }) => j.verificationStatus !== "SecurityQuarantine");
  check(noQuarantine, "the Active feed never includes a SecurityQuarantine job");
  const noDead = data.jobs.every((j: { verificationStatus: string }) => j.verificationStatus !== "Closed");
  check(noDead, "the Active feed never includes a dead/Closed posting");

  console.log("\n2) Quarantine query surfaces the non-VERIFIED_OFFICIAL_AT_LAST_CHECK jobs");
  const qRes = await fetch(`${BASE_URL}/api/jobs?verificationStatus=Pending,NeedsReview,Closed`);
  const qData = await qRes.json();
  const noneVerified = qData.jobs.every((j: { verificationStatus: string }) => j.verificationStatus !== "VERIFIED_OFFICIAL_AT_LAST_CHECK");
  check(noneVerified, `quarantine query never includes VERIFIED_OFFICIAL_AT_LAST_CHECK jobs (got ${qData.jobs.length} jobs)`);

  console.log("\n3) Manually entered jobs are trusted (VERIFIED_OFFICIAL_AT_LAST_CHECK) with correct evidence fields");
  const createRes = await fetch(`${BASE_URL}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Test Manual Verification Intern",
      company: "Test Manual Co",
      description: "A manually entered internship for testing.",
      url: "https://careers.testmanualco.example/apply/123",
    }),
  });
  const created = await createRes.json();
  check(createRes.status === 201, `manual job created (status ${createRes.status})`);
  check(created.job.verificationStatus === "VERIFIED_OFFICIAL_AT_LAST_CHECK", "manual entry is VERIFIED_OFFICIAL_AT_LAST_CHECK");
  check(created.job.verificationMethod === "manual-entry", `verificationMethod is manual-entry (got ${created.job.verificationMethod})`);
  check(
    created.job.officialEmployerDomain === "careers.testmanualco.example",
    `officialEmployerDomain extracted correctly (got ${created.job.officialEmployerDomain})`,
  );
  check(/Verified on the official employer application page at/.test(created.job.verificationReason ?? ""), "verification reason uses the required exact phrasing");
  check(!/permanent|100%|guarantee/i.test(created.job.verificationReason ?? ""), "verification reason never claims permanent/100% certainty");

  console.log("\n4) Reverify-before-apply: a network failure holds for re-verification (never falsely closes)");
  const brokenUrlJob = await prisma.job.create({
    data: {
      title: "Test Broken Link Intern",
      company: "Test Broken Co",
      description: "desc",
      url: "https://this-domain-should-not-exist-12345.example/job/1",
      status: "DISCOVERED",
      verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
      verificationMethod: "greenhouse-board-match",
      lastVerifiedAt: new Date(Date.now() - 1000 * 60 * 60 * 25),
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    },
  });
  const reverifyRes = await fetch(`${BASE_URL}/api/jobs/${brokenUrlJob.id}/verify`, { method: "POST" });
  const reverifyData = await reverifyRes.json();
  check(reverifyRes.ok, `reverify request succeeded (status ${reverifyRes.status})`);
  check(reverifyData.job.reasonCode === "NETWORK_FAILURE", `reasonCode is NETWORK_FAILURE (got ${reverifyData.job.reasonCode})`);
  check(/inconclusive|holding for re-verification/i.test(reverifyData.job.verificationReason ?? ""), `exact inconclusive reason recorded: "${reverifyData.job.verificationReason}"`);
  await prisma.job.delete({ where: { id: brokenUrlJob.id } });

  console.log("\n5) Cleanup test data");
  await prisma.job.deleteMany({ where: { company: { in: ["Test Manual Co", "Test Broken Co"] } } });
  console.log("  done");

  console.log(failures === 0 ? "\nAll strict-verification tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Strict verification test crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

