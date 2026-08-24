import "dotenv/config";
import { prisma } from "@/lib/db";
import { ingestJobs } from "@/lib/sync/ingest";
import { verifyPendingJob } from "@/lib/sync/queue";
import type { RawInternListJob } from "@/lib/sync/internListAdapter";

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

function fixtureJob(overrides: Partial<RawInternListJob>): RawInternListJob {
  return {
    sourceJobId: "test-filter-job",
    title: "Generic Intern",
    company: "Test Filter Co",
    location: "Clifton, NJ, United States",
    workModel: "On Site",
    postedAt: new Date(),
    hireTime: "2027-Summer",
    salary: "N/A",
    qualifications: "General qualifications text.",
    applyUrl: "https://jobright.ai/jobs/info/test-filter-job",
    h1bSponsored: "Unknown",
    ...overrides,
  } as RawInternListJob;
}

async function cleanup(ids: string[]) {
  await prisma.job.deleteMany({ where: { source: "intern-list", sourceJobId: { in: ids } } });
}

async function testFilters() {
  const jobA = fixtureJob({
    sourceJobId: "test-filter-job-a",
    title: "Electrical Engineering Intern",
    company: "Test Filter Electrical Co",
    location: "Clifton, NJ, United States",
    workModel: "On Site",
    qualifications:
      "Electrical engineering internship. Open to sophomores. Looking for Class of 2028 graduates.",
    salary: "$25-$30/hr",
    h1bSponsored: "Yes",
  });
  const jobB = fixtureJob({
    sourceJobId: "test-filter-job-b",
    title: "Embedded Software Intern",
    company: "Test Filter Embedded Co",
    location: "Los Angeles, CA, United States",
    workModel: "Remote",
    qualifications: "Embedded systems internship. Requires U.S. citizen with active security clearance.",
    salary: "N/A",
    h1bSponsored: "No",
  });

  await cleanup(["test-filter-job-a", "test-filter-job-b"]);
  // This test exercises filter/scoring logic, not the strict discovery-
  // boundary allowlist gate — pre-register these fixture employers as
  // allowlisted, standing in for "already on the CSV or manually added."
  const filterCompanyNames = ["Test Filter Electrical Co", "Test Filter Embedded Co"];
  await prisma.company.deleteMany({ where: { name: { in: filterCompanyNames } } });
  await prisma.company.createMany({
    data: filterCompanyNames.map((name) => ({ name, source: "manual", allowlisted: true })),
  });
  await ingestJobs([jobA, jobB]);
  await prisma.job.updateMany({
    where: { source: "intern-list", sourceJobId: { in: ["test-filter-job-a", "test-filter-job-b"] } },
    data: { verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK" },
  });

  // This test exercises FILTER logic, not the Active-feed VISIBILITY policy
  // (the "Test Filter" fixture companies are intentionally treated as demo
  // fixtures and excluded from the Active feed). Query feed=all so the
  // filter assertions see the fixtures regardless of visibility.
  async function fetchIds(query: string): Promise<string[]> {
    const res = await fetch(`${BASE_URL}/api/jobs?${query}&feed=all`);
    const data = await res.json();
    return (data.jobs as { sourceJobId: string | null }[])
      .map((j) => j.sourceJobId)
      .filter((id): id is string => id !== null && id.startsWith("test-filter-job"));
  }

  console.log("5) Filters: discipline tags");
  check(
    JSON.stringify((await fetchIds("disciplines=electrical")).sort()) === JSON.stringify(["test-filter-job-a"]),
    "disciplines=electrical returns only the electrical job",
  );
  check(
    JSON.stringify((await fetchIds("disciplines=embedded")).sort()) === JSON.stringify(["test-filter-job-b"]),
    "disciplines=embedded returns only the embedded job",
  );

  console.log("\n6) Filters: eligibility heuristics");
  const sophomoreIds = await fetchIds("sophomoreEligible=true");
  check(sophomoreIds.includes("test-filter-job-a") && !sophomoreIds.includes("test-filter-job-b"), "sophomoreEligible=true matches only job A");

  const clearanceIds = await fetchIds("citizenshipOrClearance=true");
  check(clearanceIds.includes("test-filter-job-b") && !clearanceIds.includes("test-filter-job-a"), "citizenshipOrClearance=true matches only job B");

  const sponsorIds = await fetchIds("sponsorship=Yes");
  check(sponsorIds.includes("test-filter-job-a") && !sponsorIds.includes("test-filter-job-b"), "sponsorship=Yes matches only job A");

  console.log("\n7) Filters: distance + remote toggle");
  const nearOnly = await fetchIds("maxDistanceMiles=10");
  check(nearOnly.includes("test-filter-job-a") && !nearOnly.includes("test-filter-job-b"), "maxDistanceMiles=10 (no remote) excludes the far-away non-remote job");

  const nearPlusRemote = await fetchIds("maxDistanceMiles=10&includeRemoteRegardlessOfDistance=true");
  check(
    nearPlusRemote.includes("test-filter-job-a") && nearPlusRemote.includes("test-filter-job-b"),
    "maxDistanceMiles=10 + includeRemote also includes the remote job regardless of distance",
  );

  console.log("\n8) Filters: compensation + graduation year");
  const compIds = await fetchIds("compMin=20");
  check(compIds.includes("test-filter-job-a") && !compIds.includes("test-filter-job-b"), "compMin=20 matches only the job with listed pay");

  const gradIds = await fetchIds("graduationYear=2028");
  check(gradIds.includes("test-filter-job-a"), "graduationYear=2028 matches the job mentioning Class of 2028");

  await cleanup(["test-filter-job-a", "test-filter-job-b"]);
  await prisma.company.deleteMany({ where: { name: { in: filterCompanyNames } } });
}

async function testAutomaticScoring() {
  console.log("\n9) Automatic scoring after verification");

  const approvedFacts = await prisma.resumeFact.count({ where: { status: { in: ["approved", "edited"] } } });
  if (approvedFacts === 0) {
    console.log("  SKIP: no approved resume facts (run `npm run seed` first)");
    return;
  }

  const id = "test-autoscore-job";
  await prisma.job.deleteMany({ where: { source: "intern-list", sourceJobId: id } });

  const created = await prisma.job.create({
    data: {
      title: "Software Engineering Intern",
      company: "Test Autoscore Co",
      location: "Remote",
      description:
        "Looking for a Python and SQL intern pursuing a Computer Science degree. GPA 3.0+ preferred.",
      status: "DISCOVERED",
      source: "intern-list",
      sourceJobId: id,
      workplaceType: "Remote",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      verificationStatus: "Pending",
    },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("boards-api.greenhouse.io/v1/boards/testautoscore/jobs")) {
      return {
        ok: true,
        json: async () => ({
          jobs: [
            {
              title: "Software Engineering Intern",
              absolute_url: "https://boards.greenhouse.io/testautoscoreco/jobs/1",
              location: { name: "Remote" },
              content: "Full official description text.",
            },
          ],
        }),
      } as Response;
    }
    if (url.includes("boards-api.greenhouse.io") || url.includes("api.lever.co") || url.includes("api.ashbyhq.com")) {
      return { ok: false, status: 404, json: async () => null } as Response;
    }
    // Anything else (e.g. the real Ollama call) passes through untouched.
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const { outcome, scored } = await verifyPendingJob({
      id: created.id,
      title: created.title,
      company: created.company,
      location: created.location,
      workplaceType: created.workplaceType,
    });

    check(outcome === "VERIFIED_OFFICIAL_AT_LAST_CHECK", `job was verified (got ${outcome})`);
    check(scored === true, "automatic scoring ran immediately after verification");

    const final = await prisma.job.findUnique({
      where: { id: created.id },
      include: { matchResults: true },
    });
    check(final?.matchScore !== null && final?.matchScore !== undefined, "job.matchScore was populated");
    check(!!final?.eligibilityStatus, "job.eligibilityStatus was populated");
    check((final?.matchResults.length ?? 0) > 0, "a MatchResult row was created automatically");
  } finally {
    globalThis.fetch = originalFetch;
    await prisma.job.deleteMany({ where: { source: "intern-list", sourceJobId: id } });
  }
}

async function main() {
  await testFilters();
  await testAutomaticScoring();
  console.log(failures === 0 ? "\nAll filter/scoring tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Filter/scoring test crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

