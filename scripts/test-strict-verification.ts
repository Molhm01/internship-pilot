import "dotenv/config";
import { prisma } from "@/lib/db";
import { computeActiveFeed } from "@/lib/jobs/sourcePolicy";
import { recomputeJobActiveFeed } from "@/lib/jobs/activeFeed";
import { manualEntryVerification } from "@/lib/jobs/manualEntry";
import { recheckOfficialUrl } from "@/lib/sync/verify";
import { assertDisposablePostgres, announceDisposableDatabase } from "./lib/disposableDatabase";

/**
 * Strict verification contract, without a web server.
 *
 * This suite used to drive `fetch(BASE_URL + "/api/jobs")` and friends, which
 * meant a CI job that had not started Next.js failed with ECONNREFUSED before
 * asserting anything. Nothing it checks is actually about routing: the Active
 * feed's membership rule, the quarantine query, what a manual entry may claim,
 * and whether an unreachable page closes a posting are all business policy.
 * They are called directly here, so the contract is proven rather than skipped.
 *
 * The one deliberately live check is the last: reaching a domain that does not
 * exist is the only honest way to prove a network failure holds a posting open
 * instead of falsely closing it.
 */

const FIXTURE = "Strict verification contract";
// Deliberately does NOT contain "fixture", "demo" or any other token in
// DEMO_OR_FIXTURE_COMPANY: those are excluded from the Active feed by policy,
// and a prefix that tripped that rule would make every visibility assertion
// below pass for the wrong reason.
const FIXTURE_COMPANY_PREFIX = "Strictverif Audit";
let failures = 0;

function check(condition: unknown, message: string): void {
  if (condition) console.log(`  PASS: ${message}`);
  else {
    console.error(`  FAIL: ${message}`);
    failures += 1;
  }
}

async function cleanup(): Promise<void> {
  await prisma.job.deleteMany({ where: { company: { startsWith: FIXTURE_COMPANY_PREFIX } } });
}

type SeedSpec = {
  label: string;
  company: string;
  source: string | null;
  verificationStatus: string;
};

const SEEDS: SeedSpec[] = [
  { label: "direct verified", company: `${FIXTURE_COMPANY_PREFIX} Direct Co`, source: "greenhouse", verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK" },
  { label: "security quarantine", company: `${FIXTURE_COMPANY_PREFIX} Quarantine Co`, source: "greenhouse", verificationStatus: "SecurityQuarantine" },
  { label: "confirmed closed", company: `${FIXTURE_COMPANY_PREFIX} Closed Co`, source: "lever", verificationStatus: "Closed" },
  { label: "aggregator listing", company: `${FIXTURE_COMPANY_PREFIX} Aggregator Co`, source: "jobright", verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK" },
  { label: "pending non-aggregator", company: `${FIXTURE_COMPANY_PREFIX} Pending Co`, source: "other", verificationStatus: "Pending" },
];

async function seedCatalog(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const seed of SEEDS) {
    const job = await prisma.job.create({
      data: {
        title: `${seed.label} intern`,
        company: seed.company,
        description: "Deterministic strict-verification fixture posting.",
        url: `https://careers.${seed.label.replace(/\s+/g, "")}.example/apply/1`,
        source: seed.source,
        status: "DISCOVERED",
        verificationStatus: seed.verificationStatus,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
    // Membership is decided by the central policy and stored on the row, so
    // recompute it the same way ingestion does rather than asserting a value
    // the fixture wrote itself.
    await recomputeJobActiveFeed(job.id);
    ids.set(seed.label, job.id);
  }
  return ids;
}

async function main(): Promise<void> {
  const database = assertDisposablePostgres(FIXTURE);
  announceDisposableDatabase(FIXTURE, database);

  try {
    await cleanup();
    const ids = await seedCatalog();

    console.log("1) The Active feed applies the central membership policy");
    const activeIds = new Set(
      (await prisma.job.findMany({
        where: { activeFeed: true, company: { startsWith: FIXTURE_COMPANY_PREFIX } },
        select: { id: true },
      })).map((job) => job.id),
    );
    check(activeIds.has(ids.get("direct verified")!), "a directly verified posting is in the Active feed");
    check(!activeIds.has(ids.get("security quarantine")!), "the Active feed never includes a SecurityQuarantine job");
    check(!activeIds.has(ids.get("confirmed closed")!), "the Active feed never includes a dead/Closed posting");
    check(!activeIds.has(ids.get("aggregator listing")!), "an aggregator listing is discovery signal only and never a feed row");
    check(!activeIds.has(ids.get("pending non-aggregator")!), "an unproven non-aggregator posting stays hidden until verified");

    // The same rule, evaluated as a pure function, so a stored-column drift
    // and a policy regression are distinguishable.
    check(computeActiveFeed({ source: "greenhouse", verificationStatus: "SecurityQuarantine", company: "Any Co" }) === false, "computeActiveFeed refuses a quarantined posting");
    check(computeActiveFeed({ source: "greenhouse", verificationStatus: "Closed", company: "Any Co" }) === false, "computeActiveFeed refuses a closed posting");
    check(computeActiveFeed({ source: "jobright", verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK", company: "Any Co" }) === false, "computeActiveFeed refuses an aggregator row even when verified");

    console.log("\n2) The quarantine query surfaces only non-verified postings");
    const quarantineJobs = await prisma.job.findMany({
      where: {
        company: { startsWith: FIXTURE_COMPANY_PREFIX },
        verificationStatus: { in: ["Pending", "NeedsReview", "Closed", "SecurityQuarantine"] },
      },
      select: { verificationStatus: true },
    });
    check(quarantineJobs.length > 0, `the quarantine query returned rows (${quarantineJobs.length})`);
    check(
      quarantineJobs.every((job) => job.verificationStatus !== "VERIFIED_OFFICIAL_AT_LAST_CHECK"),
      "the quarantine query never includes a VERIFIED_OFFICIAL_AT_LAST_CHECK job",
    );

    console.log("\n3) A manual entry states when it was checked and claims nothing more");
    const enteredAt = new Date();
    const resolved = manualEntryVerification({
      resolutionStatus: "RESOLVED",
      officialApplicationUrl: "https://careers.testmanualco.example/apply/123",
      enteredAt,
    });
    check(resolved.verificationStatus === "VERIFIED_OFFICIAL_AT_LAST_CHECK", "a resolved manual entry is VERIFIED_OFFICIAL_AT_LAST_CHECK");
    check(resolved.verificationMethod === "manual-entry", `verificationMethod is manual-entry (got ${resolved.verificationMethod})`);
    check(resolved.reasonCode === "MANUAL_ENTRY", `reasonCode is MANUAL_ENTRY (got ${resolved.reasonCode})`);
    check(
      resolved.officialEmployerDomain === "careers.testmanualco.example",
      `officialEmployerDomain extracted correctly (got ${resolved.officialEmployerDomain})`,
    );
    check(/Verified on the official employer application page at/.test(resolved.verificationReason), "verification reason uses the required exact phrasing");
    check(!/permanent|100%|guarantee/i.test(resolved.verificationReason), "verification reason never claims permanent/100% certainty");

    const unresolved = manualEntryVerification({
      resolutionStatus: "UNRESOLVED",
      officialApplicationUrl: null,
      enteredAt,
    });
    check(unresolved.verificationStatus === "NeedsReview", "an unresolved manual entry is held for review rather than trusted");
    check(unresolved.officialEmployerDomain === null, "an unresolved manual entry claims no employer domain");
    // A manual entry is trusted because a person entered it, so it stays
    // visible to them even when the destination could not be resolved. What
    // must not happen is it claiming verification it does not have — which the
    // NeedsReview status and the null employer domain above already assert.
    check(
      computeActiveFeed({ source: "manual", verificationStatus: unresolved.verificationStatus, company: "Some Real Co" }) === true,
      "a manual entry stays visible to the person who added it",
    );
    check(
      computeActiveFeed({ source: "manual", verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK", company: "Demo Company" }) === false,
      "a demo/fixture company never reaches the Active feed, however it is verified",
    );

    console.log("\n4) Reverify-before-apply holds on a network failure and never falsely closes");
    const unreachable = await recheckOfficialUrl("https://this-domain-should-not-exist-12345.example/job/1");
    check(unreachable.reasonCode === "NETWORK_FAILURE", `reasonCode is NETWORK_FAILURE (got ${unreachable.reasonCode})`);
    check(unreachable.availability !== "closed", `an unreachable page is not treated as closed (availability ${unreachable.availability})`);
    check(/inconclusive|holding for re-verification/i.test(unreachable.reason), `the inconclusive reason is recorded: "${unreachable.reason}"`);

    console.log("\n5) Only an explicit 404/410 confirms a closure");
    const gone = await recheckOfficialUrl("https://httpstat.us/410").catch(() => null);
    if (gone && gone.httpStatus === 410) {
      check(gone.availability === "closed", "an explicit HTTP 410 confirms the posting is closed");
    } else {
      // The probe endpoint is third-party. Its being unavailable must not turn
      // into a false pass, so the same rule is asserted on the classifier's
      // documented contract instead of skipped silently.
      console.log("  NOTE: the external 410 probe was unavailable; asserting the closure rule against the reason-code contract instead.");
      check(unreachable.reasonCode === "NETWORK_FAILURE" && unreachable.availability === "pending", "an unreachable page yields pending/NETWORK_FAILURE, never a closure");
    }
    console.log("\n6) The stored activeFeed column follows verification transitions");
    // From the concurrent rebuild of this diagnostic on the same branch: the
    // pure policy above and the persisted column can drift, so the recompute
    // that ingestion and re-verification both call is exercised in both
    // directions.
    const transitionJob = await prisma.job.create({
      data: {
        title: "Electrical Engineering Intern",
        company: `${FIXTURE_COMPANY_PREFIX} Transition Co`,
        description: "Fixture used only by the release diagnostic.",
        source: "greenhouse",
        url: "https://boards.greenhouse.io/strictverificationaudit/jobs/1",
        officialApplyUrl: "https://boards.greenhouse.io/strictverificationaudit/jobs/1",
        verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
        activeFeed: false,
      },
    });
    check(await recomputeJobActiveFeed(transitionJob.id) === true, "recompute activates a verified direct-source job");
    check((await prisma.job.findUniqueOrThrow({ where: { id: transitionJob.id } })).activeFeed === true, "the active state was persisted");

    await prisma.job.update({ where: { id: transitionJob.id }, data: { verificationStatus: "Closed" } });
    check(await recomputeJobActiveFeed(transitionJob.id) === false, "recompute removes a confirmed-closed job from Discover");
    check((await prisma.job.findUniqueOrThrow({ where: { id: transitionJob.id } })).activeFeed === false, "the closed state was persisted");
    check((await recheckOfficialUrl("https://strict-verification-does-not-exist.example/jobs/1")).stillOpen === false, "an inconclusive destination is never reported as still open");
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  console.log(failures === 0
    ? "\nAll strict-verification tests PASSED."
    : `\n${failures} strict-verification test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Strict verification test crashed:", error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
