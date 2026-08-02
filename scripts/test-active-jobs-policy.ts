import "dotenv/config";
import { prisma } from "@/lib/db";
import {
  canonicalizeSource,
  computeActiveFeed,
  isTrustedAggregatorSource,
  verificationStateOf,
} from "@/lib/jobs/sourcePolicy";
import { backfillActiveFeed, recomputeJobActiveFeed } from "@/lib/jobs/activeFeed";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const PREFIX = "ActivePolicyTest";

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) console.log(`  PASS: ${message}`);
  else { console.error(`  FAIL: ${message}`); failures += 1; }
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
      // Intentionally stored WRONG so the backfill/recompute has to fix it.
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
  check(isTrustedAggregatorSource("Jobright AI") && isTrustedAggregatorSource("simplify.jobs") && isTrustedAggregatorSource("intern-list.com"), "all three families are trusted");
  check(!isTrustedAggregatorSource("greenhouse") && !isTrustedAggregatorSource("linkedin"), "greenhouse/linkedin are NOT trusted aggregators");

  console.log("\n2) computeActiveFeed policy");
  check(computeActiveFeed({ source: "intern-list", verificationStatus: "NeedsReview", company: "Acme" }) === true, "trusted + NeedsReview -> active");
  check(computeActiveFeed({ source: "Jobright AI", verificationStatus: "Pending", company: "Acme" }) === true, "trusted + Pending -> active");
  check(computeActiveFeed({ source: "simplify.jobs", verificationStatus: "CLOSED_OR_UNVERIFIED", company: "Acme" }) === true, "trusted + CLOSED_OR_UNVERIFIED -> active (verification pending, not dead)");
  check(computeActiveFeed({ source: "intern-list", verificationStatus: "Closed", company: "Acme" }) === false, "trusted + Closed (dead) -> NOT active");
  check(computeActiveFeed({ source: "intern-list", verificationStatus: "SecurityQuarantine", company: "Acme" }) === false, "trusted + SecurityQuarantine -> NOT active");
  check(computeActiveFeed({ source: "greenhouse", verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK", company: "Acme" }) === true, "any source + VERIFIED -> active");
  check(computeActiveFeed({ source: "linkedin", verificationStatus: "NeedsReview", company: "Acme" }) === false, "untrusted source + NeedsReview -> NOT active (stays Needs Review)");
  check(computeActiveFeed({ source: null, verificationStatus: "NeedsReview", company: "Acme" }) === false, "null source + NeedsReview -> NOT active");
  check(computeActiveFeed({ source: "intern-list", verificationStatus: "NeedsReview", company: "Mock ATS Test Co" }) === false, "demo/fixture company -> NOT active");
  check(verificationStateOf("NeedsReview") === "verification_pending" && verificationStateOf("VERIFIED_OFFICIAL_AT_LAST_CHECK") === "official_destination_verified" && verificationStateOf("Closed") === "destination_unavailable", "verificationStateOf maps the four states");

  console.log("\n3) Backfill fixes visibility WITHOUT changing verification state");
  const trapped = await makeJob(`${PREFIX} Jobright`, "jobright.ai", "NeedsReview");
  const untrusted = await makeJob(`${PREFIX} Linkedin`, "linkedin", "NeedsReview");
  const dead = await makeJob(`${PREFIX} Closed`, "intern-list", "Closed");
  const verifiedGh = await makeJob(`${PREFIX} Greenhouse`, "ats:greenhouse", "VERIFIED_OFFICIAL_AT_LAST_CHECK");
  await backfillActiveFeed();
  const afterTrapped = await prisma.job.findUnique({ where: { id: trapped.id } });
  const afterUntrusted = await prisma.job.findUnique({ where: { id: untrusted.id } });
  const afterDead = await prisma.job.findUnique({ where: { id: dead.id } });
  const afterVerified = await prisma.job.findUnique({ where: { id: verifiedGh.id } });
  check(afterTrapped?.activeFeed === true, "trapped Jobright NeedsReview job is now active after backfill");
  check(afterTrapped?.verificationStatus === "NeedsReview", "...and its verificationStatus is UNCHANGED (still NeedsReview)");
  check(afterUntrusted?.activeFeed === false, "untrusted-source NeedsReview job stays out of Active");
  check(afterDead?.activeFeed === false, "closed/dead trusted job stays out of Active");
  check(afterVerified?.activeFeed === true, "verified job is active");

  console.log("\n4) Jobs API default feed reflects the policy (requires dev server)");
  let apiReachable = true;
  try {
    const activeRes = await fetch(`${BASE_URL}/api/jobs?feed=active`);
    const activeData = await activeRes.json();
    const activeIds = new Set((activeData.jobs ?? []).map((j: { id: string }) => j.id));
    check(activeIds.has(trapped.id), "Active feed INCLUDES the trapped Jobright job");
    check(!activeIds.has(untrusted.id), "Active feed EXCLUDES the untrusted-source job");
    check(!activeIds.has(dead.id), "Active feed EXCLUDES the closed job");

    const nrRes = await fetch(`${BASE_URL}/api/jobs?feed=needsReview`);
    const nrData = await nrRes.json();
    const nrIds = new Set((nrData.jobs ?? []).map((j: { id: string }) => j.id));
    check(nrIds.has(untrusted.id), "Needs Review feed INCLUDES the untrusted-source job");
    check(!nrIds.has(trapped.id), "Needs Review feed EXCLUDES the now-active Jobright job");

    const countsRes = await fetch(`${BASE_URL}/api/jobs/counts`);
    const counts = await countsRes.json();
    check(typeof counts.active === "number" && typeof counts.verificationPending === "number", `counts endpoint returns numbers (active=${counts.active}, verificationPending=${counts.verificationPending})`);
  } catch (error) {
    apiReachable = false;
    console.log(`  SKIP: dev server not reachable (${error instanceof Error ? error.message : String(error)})`);
  }

  console.log("\n5) New ingestion enters Active immediately; recompute is idempotent");
  const fresh = await makeJob(`${PREFIX} SimplifyFresh`, "Simplify AI", "Pending");
  // Simulate what ingest does: it sets activeFeed at create via computeActiveFeed.
  const shouldBeActive = computeActiveFeed({ source: "Simplify AI", verificationStatus: "Pending", company: fresh.company });
  await prisma.job.update({ where: { id: fresh.id }, data: { activeFeed: shouldBeActive } });
  check(shouldBeActive === true, "a fresh Simplify Pending job computes active=true at ingest");
  const r1 = await recomputeJobActiveFeed(fresh.id);
  const r2 = await recomputeJobActiveFeed(fresh.id);
  check(r1 === true && r2 === true, "recompute is idempotent");

  console.log("\n6) Cleanup");
  await cleanup();
  console.log("  done");

  console.log(failures === 0 ? "\nAll active-jobs-policy tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
  if (!apiReachable) console.log("(Note: section 4 was skipped because the dev server was not running.)");
}

void main()
  .catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
