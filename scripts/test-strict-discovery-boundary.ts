import "dotenv/config";
import { prisma } from "@/lib/db";
import { ingestJobs } from "@/lib/sync/ingest";
import type { RawInternListJob } from "@/lib/sync/internListAdapter";

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

function fixtureJob(overrides: Partial<RawInternListJob>): RawInternListJob {
  return {
    sourceJobId: "test-boundary-job",
    title: "Generic Intern",
    company: "Test Boundary Co",
    location: "Remote",
    workModel: "Remote",
    postedAt: new Date(),
    hireTime: "2027-Summer",
    salary: "N/A",
    qualifications: "General qualifications text.",
    applyUrl: "https://example.com/apply/test-boundary-job",
    h1bSponsored: "Unknown",
    ...overrides,
  };
}

const NEW_EMPLOYER_NAME = "Totally Unlisted Engineering Co";

async function cleanup() {
  await prisma.job.deleteMany({ where: { source: "intern-list", sourceJobId: { startsWith: "test-boundary-job" } } });
  await prisma.newEmployerReview.deleteMany({ where: { employerName: NEW_EMPLOYER_NAME } });
  await prisma.company.deleteMany({ where: { name: NEW_EMPLOYER_NAME } });
}

async function main() {
  await cleanup();

  console.log("1) An Intern List job from an employer NOT on the CSV/manual allowlist is never ingested as a Job");
  const job = fixtureJob({ sourceJobId: "test-boundary-job-1", company: NEW_EMPLOYER_NAME });
  const summary = await ingestJobs([job]);
  check(summary.newCount === 0, `no Job row was created (newCount=${summary.newCount})`);
  const jobRow = await prisma.job.findFirst({ where: { source: "intern-list", sourceJobId: "test-boundary-job-1" } });
  check(jobRow === null, "confirmed: no Job row exists for the unlisted employer");

  console.log("\n2) Instead, it lands in NEW_EMPLOYER_REVIEW, pending — never auto-approved");
  const reviewEntry = await prisma.newEmployerReview.findUnique({ where: { employerName: NEW_EMPLOYER_NAME } });
  check(!!reviewEntry, "a NewEmployerReview row was created");
  check(reviewEntry?.status === "pending", `status is "pending" (got ${reviewEntry?.status})`);
  check(reviewEntry?.discoveredFrom === "intern-list", "discoveredFrom is intern-list");

  console.log("\n3) Once the user approves the employer via the API, it becomes allowlisted and future jobs ingest normally");
  const approveRes = await fetch(`${process.env.BASE_URL ?? "http://localhost:3000"}/api/new-employer-review/${reviewEntry!.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve", officialDomain: "totally-unlisted-eng.example" }),
  });
  check(approveRes.ok, `approval request succeeded (status ${approveRes.status})`);
  const company = await prisma.company.findUnique({ where: { name: NEW_EMPLOYER_NAME } });
  check(!!company && company.allowlisted === true, `company is now allowlisted (got ${JSON.stringify({ allowlisted: company?.allowlisted, source: company?.source })})`);
  check(company?.source === "intern-list-approved", `source is "intern-list-approved" (got ${company?.source})`);

  const job2 = fixtureJob({ sourceJobId: "test-boundary-job-2", company: NEW_EMPLOYER_NAME });
  const summary2 = await ingestJobs([job2]);
  check(summary2.newCount === 1, `after approval, a job from this employer IS ingested (newCount=${summary2.newCount})`);

  console.log("\n4) Cleanup");
  await cleanup();
  console.log("  done");

  console.log(failures === 0 ? "\nAll strict-discovery-boundary tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Strict discovery boundary test crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
