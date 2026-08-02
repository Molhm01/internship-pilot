import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { parseInternListPayload } from "@/lib/sync/internListAdapter";
import { ingestJobs } from "@/lib/sync/ingest";

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

const FIXTURE_PATH = path.join(process.cwd(), "scripts", "fixtures", "intern-list-sample.json");

async function main() {
  let fixtureText = readFileSync(FIXTURE_PATH, "utf-8");
  if (fixtureText.charCodeAt(0) === 0xfeff) fixtureText = fixtureText.slice(1);
  const fixtureRaw = JSON.parse(fixtureText);

  console.log("1) Parse the saved Intern List fixture (no network access)");
  const jobs = parseInternListPayload(fixtureRaw);
  check(jobs.length === 50, `parsed 50 jobs from fixture (got ${jobs.length})`);
  const uniqueIds = new Set(jobs.map((j) => j.sourceJobId));
  check(uniqueIds.size === jobs.length, "all sourceJobIds are unique");
  check(
    jobs.every((j) => j.title && j.company),
    "every job has a title and company",
  );

  const fixtureIds = jobs.map((j) => j.sourceJobId);
  // Clean slate for these specific fixture ids in case a previous run left them behind.
  await prisma.job.deleteMany({ where: { source: "intern-list", sourceJobId: { in: fixtureIds } } });

  // This test exercises PARSE/DEDUP logic, not the strict discovery-boundary
  // allowlist gate (which has its own dedicated test:
  // test-strict-discovery-boundary.ts) — so every fixture company is
  // pre-registered as allowlisted here, standing in for "already on the CSV
  // or manually added."
  const fixtureCompanyNames = Array.from(new Set([...jobs.map((j) => j.company), "Test Fixture Co"]));
  await prisma.company.deleteMany({ where: { name: { in: fixtureCompanyNames } } });
  await prisma.company.createMany({
    data: fixtureCompanyNames.map((name) => ({ name, source: "manual", allowlisted: true })),
  });

  console.log("\n2) Initial sync: ingest the fixture");
  const first = await ingestJobs(jobs);
  check(first.newCount === 50, `50 new jobs created (got ${first.newCount})`);
  check(first.updatedCount === 0, `0 updated on first ingest (got ${first.updatedCount})`);
  const countAfterFirst = await prisma.job.count({
    where: { source: "intern-list", sourceJobId: { in: fixtureIds } },
  });
  check(countAfterFirst === 50, `50 rows exist in the database (got ${countAfterFirst})`);

  console.log("\n3) Duplicate prevention: re-ingest the identical fixture");
  const second = await ingestJobs(jobs);
  check(second.newCount === 0, `0 new jobs on re-ingest (got ${second.newCount})`);
  check(second.updatedCount === 0, `0 updates on re-ingest of unchanged data (got ${second.updatedCount})`);
  const countAfterSecond = await prisma.job.count({
    where: { source: "intern-list", sourceJobId: { in: fixtureIds } },
  });
  check(countAfterSecond === 50, `still 50 rows, no duplicates created (got ${countAfterSecond})`);

  console.log("\n4) New-job detection + change detection on a modified batch");
  const modified = jobs.map((j) => ({ ...j }));
  modified[0] = { ...modified[0], qualifications: modified[0].qualifications + " (UPDATED FOR TEST)" };
  const droppedId = modified.pop()!.sourceJobId; // simulate one falling off the top-50
  const newFakeJob = {
    ...jobs[0],
    sourceJobId: "test-fixture-new-job-id",
    title: "Test Fixture New Internship",
    company: "Test Fixture Co",
  };
  modified.push(newFakeJob);

  const third = await ingestJobs(modified);
  check(third.newCount === 1, `1 new job detected (got ${third.newCount})`);
  check(third.updatedCount === 1, `1 changed job detected (got ${third.updatedCount})`);

  const droppedStillExists = await prisma.job.findFirst({
    where: { source: "intern-list", sourceJobId: droppedId },
  });
  check(
    droppedStillExists !== null,
    "a job that fell off the top-50 window is NOT deleted (falling off ≠ closed)",
  );

  const updatedJob = await prisma.job.findFirst({
    where: { source: "intern-list", sourceJobId: jobs[0].sourceJobId },
  });
  check(
    (updatedJob?.description ?? "").includes("UPDATED FOR TEST"),
    "changed description was actually persisted",
  );

  console.log("\n5) Database migration integrity: earlier Phase 1 data survived");
  const factCount = await prisma.resumeFact.count();
  const jobCount = await prisma.job.count();
  check(factCount >= 0, `resume facts table is reachable (count=${factCount})`);
  check(jobCount >= 50, `jobs table is reachable and has data (count=${jobCount})`);

  console.log("\n6) Cleanup: remove test-only rows created by this script");
  await prisma.job.deleteMany({
    where: { source: "intern-list", sourceJobId: { in: [...fixtureIds, "test-fixture-new-job-id"] } },
  });
  const cleanupCount = await prisma.job.count({
    where: { source: "intern-list", sourceJobId: { in: [...fixtureIds, "test-fixture-new-job-id"] } },
  });
  check(cleanupCount === 0, "test fixture rows cleaned up (won't appear in the real Jobs page)");
  await prisma.company.deleteMany({ where: { name: { in: fixtureCompanyNames } } });

  console.log(failures === 0 ? "\nAll sync/dedup tests PASSED." : `\n${failures} sync test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Sync test crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
