import "dotenv/config";
import { prisma } from "@/lib/db";
import { isTargetEngineeringRole } from "@/lib/sync/classify";
import { detectAtsFromText } from "@/lib/ats/detect";
import { ingestAtsJobs } from "@/lib/sync/ingest";
import { checkCompany } from "@/lib/sync/companyDiscovery";

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
  console.log("1) Target-role filter: full-time roles must NOT be treated as internships");
  check(
    isTargetEngineeringRole("Electrical Engineering Intern", "Assist with circuit design.") === true,
    'accepts "Electrical Engineering Intern"',
  );
  check(
    isTargetEngineeringRole("Senior Electrical Engineer", "10+ years of circuit design experience.") === false,
    "regression: rejects a full-time Senior Electrical Engineer posting (this was the Astranis over-ingestion bug)",
  );
  check(
    isTargetEngineeringRole("Marketing Intern", "Support social media campaigns.") === false,
    "rejects a non-engineering internship (Marketing Intern)",
  );
  check(
    isTargetEngineeringRole("Hardware Co-op (Spring 2027)", "PCB design and validation.") === true,
    'accepts "Hardware Co-op" as a student role',
  );

  console.log("\n2) ATS detection from URL/body text");
  check(detectAtsFromText("https://boards.greenhouse.io/acme/jobs/123").atsType === "greenhouse", "detects Greenhouse");
  check(detectAtsFromText("https://jobs.lever.co/acme/abc-123").atsType === "lever", "detects Lever");
  check(detectAtsFromText("https://jobs.ashbyhq.com/acme").atsType === "ashby", "detects Ashby");
  check(
    detectAtsFromText("https://jobs.smartrecruiters.com/Acme/1234-title").atsType === "smartrecruiters",
    "detects SmartRecruiters",
  );
  const workday = detectAtsFromText("https://acme.wd1.myworkdayjobs.com/External/job/x");
  check(
    workday.atsType === "workday" && workday.atsIdentifier === "acme.wd1/External",
    `detects Workday + exact shard/site (got ${workday.atsIdentifier})`,
  );
  check(detectAtsFromText("https://acme.taleo.net/careersection/1").atsType === "taleo", "detects Taleo");
  check(detectAtsFromText("https://www.some-random-company.com/careers").atsType === "unknown", "unknown site stays unknown (no false positive)");

  console.log("\n3) Dedup: requisition-id-based dedup across a source-agnostic ingest");
  const testCompany = "Test Nationwide Co";
  await prisma.job.deleteMany({ where: { company: testCompany } });

  const first = await ingestAtsJobs(
    [
      {
        sourceJobId: "job-abc",
        requisitionId: "REQ-1",
        title: "Electrical Engineering Intern",
        company: testCompany,
        location: "Austin, TX",
        workplaceType: "On Site",
        applyUrl: "https://boards.greenhouse.io/testnationwide/jobs/1",
        description: "Circuit design internship.",
        postedAt: new Date(),
      },
    ],
    "ats:greenhouse",
  );
  check(first.newCount === 1, `first ingest creates 1 job (got ${first.newCount})`);

  const second = await ingestAtsJobs(
    [
      {
        sourceJobId: "job-abc-relisted",
        requisitionId: "REQ-1",
        title: "Electrical Engineering Intern",
        company: testCompany,
        location: "Austin, TX",
        workplaceType: "On Site",
        applyUrl: "https://boards.greenhouse.io/testnationwide/jobs/1",
        description: "Circuit design internship.",
        postedAt: new Date(),
      },
    ],
    "ats:greenhouse",
  );
  check(second.newCount === 0, `re-listed same requisition id does not create a duplicate (got ${second.newCount})`);
  const countInDb = await prisma.job.count({ where: { company: testCompany } });
  check(countInDb === 1, `exactly 1 row exists for this requisition (got ${countInDb})`);

  await prisma.job.deleteMany({ where: { company: testCompany } });

  console.log("\n4) Live company check (Astranis, real Greenhouse board) only ingests internship titles");
  const astranis = await prisma.company.findUnique({ where: { name: "Astranis" } });
  if (!astranis) {
    console.log("  SKIP: Astranis not in Watchlist (run `npm run seed:companies` first)");
  } else {
    const result = await checkCompany(astranis.id);
    check(result.status === "success", `check succeeded (got ${result.status})`);
    const jobs = await prisma.job.findMany({ where: { company: "Astranis" } });
    check(jobs.length > 0, `at least one internship ingested (got ${jobs.length})`);
    const allHaveInternKeyword = jobs.every((j) => /intern|co-?op/i.test(j.title));
    check(allHaveInternKeyword, "every ingested Astranis job title actually contains intern/co-op");
  }

  console.log(failures === 0 ? "\nAll nationwide-discovery tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Nationwide discovery test crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
