import "dotenv/config";
import { prisma } from "@/lib/db";
import {
  canonicalizeSource,
  computeActiveFeed,
  isTrustedAggregatorSource,
  verificationStateOf,
} from "@/lib/jobs/sourcePolicy";
import { backfillActiveFeed, recomputeJobActiveFeed } from "@/lib/jobs/activeFeed";

const PREFIX = "ActivePolicyTest";
let failures = 0;

function check(condition: boolean, message: string) {
  if (condition) console.log(`  PASS: ${message}`);
  else {
    console.error(`  FAIL: ${message}`);
    failures += 1;
  }
}

async function cleanup() {
  await prisma.job.deleteMany({ where: { company: { startsWith: PREFIX } } });
}

async function makeJob(company: string, source: string | null, verificationStatus: string) {
  return prisma.job.create({
    data: {
      title: "Engineering Intern",
      company,
      description: "Fixture job for active-jobs policy tests.",
      status: "DISCOVERED",
      source,
      verificationStatus,
      activeFeed: false,
    },
  });
}

async function main() {
  await cleanup();

  console.log("1) Source-name variations normalize to one canonical token");
  for (const v of ["jobright", "jobright.ai", "Jobright AI", "https://jobright.ai/jobs/x", "jobright-ai", "JOBRIGHT"]) {
    check(canonicalizeSource(v) === "jobright", `"${v}" -> jobright (got ${canonicalizeSource(v)})`);
  }
  for (const v of ["simplify", "simplify.jobs", "Simplify AI", "simplify-jobs", "Simplify Jobs"]) {
    check(canonicalizeSource(v) === "simplify", `"${v}" -> simplify (got ${canonicalizeSource(v)})`);
  }
  for (const v of ["intern-list", "intern-list.com", "Intern List", "internlist", "INTERN_LIST"]) {
    check(canonicalizeSource(v) === "intern-list", `"${v}" -> intern-list (got ${canonicalizeSource(v)})`);
  }
  check(canonicalizeSource("ats:greenhouse") === "greenhouse", `"ats:greenhouse" -> greenhouse`);
  check(canonicalizeSource("linkedin") === "other", `unknown source -> other`);
  check(canonicalizeSource(null) === null, `null -> null`);
  check(isTrustedAggregatorSource("Jobright AI") && isTrustedAggregatorSource("simplify.jobs") && isTrustedAggregatorSource("intern-list.com"), "all three aggregator families are recognized");
  check(!isTrustedAggregatorSource("greenhouse") && !isTrustedAggregatorSource("linkedin"), "greenhouse/linkedin are not trusted aggregators");

  console.log("\n2) computeActiveFeed enforces direct-source Discover policy");
  check(computeActiveFeed({ source: "intern-list", verificationStatus: "NeedsReview", company: "Acme" }) === false, "Intern List NeedsReview stays out of Discover");
  check(computeActiveFeed({ source: "Jobright AI", verificationStatus: "Pending", company: "Acme" }) === false, "Jobright Pending stays out of Discover");
  check(computeActiveFeed({ source: "simplify.jobs", verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK", company: "Acme" }) === false, "aggregator row remains evidence-only even if a legacy row says verified");
  check(computeActiveFeed({ source: "intern-list", verificationStatus: "Closed", company: "Acme" }) === false, "closed aggregator row stays out of Discover");
  check(computeActiveFeed({ source: "greenhouse", verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK", company: "Acme" }) === true, "verified direct Greenhouse row is active");
  check(computeActiveFeed({ source: "workday", verificationStatus: "Pending", company: "Acme" }) === false, "pending direct row stays hidden until official destination is proven");
  check(computeActiveFeed({ source: "manual", verificationStatus: "NeedsReview", company: "Acme" }) === true, "explicit manual entry is visible by construction");
  check(computeActiveFeed({ source: "linkedin", verificationStatus: "NeedsReview", company: "Acme" }) === false, "untrusted source stays hidden");
  check(computeActiveFeed({ source: "greenhouse", verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK", company: "Mock ATS Test Co" }) === false, "demo/fixture company never leaks into Discover");
  check(
    verificationStateOf("NeedsReview") === "verification_pending"
      && verificationStateOf("VERIFIED_OFFICIAL_AT_LAST_CHECK") === "official_destination_verified"
      && verificationStateOf("Closed") === "destination_unavailable",
    "verificationStateOf maps canonical states",
  );

  console.log("\n3) Backfill reconciles stored activeFeed without rewriting verification evidence");
  const aggregator = await makeJob(`${PREFIX} Jobright`, "jobright.ai", "NeedsReview");
  const untrusted = await makeJob(`${PREFIX} Linkedin`, "linkedin", "NeedsReview");
  const dead = await makeJob(`${PREFIX} Closed`, "greenhouse", "Closed");
  const verifiedGh = await makeJob(`${PREFIX} Greenhouse`, "ats:greenhouse", "VERIFIED_OFFICIAL_AT_LAST_CHECK");
  await backfillActiveFeed();
  const [afterAggregator, afterUntrusted, afterDead, afterVerified] = await Promise.all([
    prisma.job.findUnique({ where: { id: aggregator.id } }),
    prisma.job.findUnique({ where: { id: untrusted.id } }),
    prisma.job.findUnique({ where: { id: dead.id } }),
    prisma.job.findUnique({ where: { id: verifiedGh.id } }),
  ]);
  check(afterAggregator?.activeFeed === false, "aggregator evidence row remains outside Discover after backfill");
  check(afterAggregator?.verificationStatus === "NeedsReview", "backfill does not falsify/change aggregator verificationStatus");
  check(afterUntrusted?.activeFeed === false, "untrusted-source row stays out of Discover");
  check(afterDead?.activeFeed === false, "confirmed closed direct row stays out of Discover");
  check(afterVerified?.activeFeed === true, "verified direct row is active");

  console.log("\n4) Recompute is idempotent under the current policy");
  const freshAggregator = await makeJob(`${PREFIX} SimplifyFresh`, "Simplify AI", "Pending");
  const aggregatorResult1 = await recomputeJobActiveFeed(freshAggregator.id);
  const aggregatorResult2 = await recomputeJobActiveFeed(freshAggregator.id);
  check(aggregatorResult1 === false && aggregatorResult2 === false, "fresh aggregator signal remains evidence-only across repeated recompute");

  const direct = await makeJob(`${PREFIX} AshbyVerified`, "ashby", "VERIFIED_OFFICIAL_AT_LAST_CHECK");
  const directResult1 = await recomputeJobActiveFeed(direct.id);
  const directResult2 = await recomputeJobActiveFeed(direct.id);
  check(directResult1 === true && directResult2 === true, "verified direct job remains active across repeated recompute");

  console.log("\n5) Cleanup");
  await cleanup();
  console.log("  done");

  console.log(failures === 0 ? "\nAll active-jobs-policy tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
