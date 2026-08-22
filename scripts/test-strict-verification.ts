import "dotenv/config";
import { prisma } from "@/lib/db";
import { computeActiveFeed } from "@/lib/jobs/sourcePolicy";
import { recomputeJobActiveFeed } from "@/lib/jobs/activeFeed";
import { recheckOfficialUrl } from "@/lib/sync/verify";

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) console.log(`  PASS: ${message}`);
  else { console.error(`  FAIL: ${message}`); failures += 1; }
}

const PREFIX = "StrictVerificationAudit";

async function cleanup() {
  await prisma.job.deleteMany({ where: { company: { startsWith: PREFIX } } });
}

async function main() {
  await cleanup();

  console.log("1) Discover visibility requires a direct/manual official source");
  check(
    computeActiveFeed({ source: "greenhouse", verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK", company: "Acme" }) === true,
    "verified Greenhouse posting is active",
  );
  check(
    computeActiveFeed({ source: "jobright", verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK", company: "Acme" }) === false,
    "Jobright remains discovery evidence only, even on a legacy verified row",
  );
  check(
    computeActiveFeed({ source: "manual", verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK", company: "Acme" }) === true,
    "explicit manual official entry is active",
  );
  check(
    computeActiveFeed({ source: "greenhouse", verificationStatus: "SecurityQuarantine", company: "Acme" }) === false,
    "security-quarantined destination is never active",
  );
  check(
    computeActiveFeed({ source: "greenhouse", verificationStatus: "Closed", company: "Acme" }) === false,
    "confirmed closed destination is never active",
  );

  console.log("\n2) Re-verification never converts a network failure into a false closure");
  const network = await recheckOfficialUrl("https://strict-verification-does-not-exist.example/jobs/1");
  check(network.availability === "pending", `network failure stays pending (got ${network.availability})`);
  check(network.reasonCode === "NETWORK_FAILURE", `network failure uses NETWORK_FAILURE (got ${network.reasonCode})`);
  check(network.stillOpen === false, "inconclusive destination is not falsely reported as open");
  check(/inconclusive|holding for re-verification|could not reach/i.test(network.reason), "reason clearly states re-verification is required");

  console.log("\n3) Persisted activeFeed follows verification transitions deterministically");
  const job = await prisma.job.create({
    data: {
      title: "Electrical Engineering Intern",
      company: `${PREFIX} Co`,
      description: "Fixture used only by the release diagnostic.",
      source: "greenhouse",
      url: "https://boards.greenhouse.io/strictverificationaudit/jobs/1",
      officialApplyUrl: "https://boards.greenhouse.io/strictverificationaudit/jobs/1",
      verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
      activeFeed: false,
    },
  });
  const opened = await recomputeJobActiveFeed(job.id);
  check(opened === true, "recompute activates a verified direct-source job");
  const openRow = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
  check(openRow.activeFeed === true, "active state was persisted");

  await prisma.job.update({ where: { id: job.id }, data: { verificationStatus: "Closed" } });
  const closed = await recomputeJobActiveFeed(job.id);
  check(closed === false, "recompute removes a confirmed-closed job from Discover");
  const closedRow = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
  check(closedRow.activeFeed === false, "closed state was persisted");

  await cleanup();
  console.log(failures === 0 ? "\nAll strict-verification tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures) process.exitCode = 1;
}

void main()
  .catch((error) => { console.error("Strict verification test crashed:", error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
