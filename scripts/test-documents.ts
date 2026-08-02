import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { extractPdfText } from "@/lib/pdf";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
if (process.env.ISOLATED_TEST_MODE !== "1") throw new Error("Refusing to run mock document identities without an isolated temporary database and output directory.");

let failures = 0;
let originalProfile: Awaited<ReturnType<typeof prisma.applicationProfile.findUnique>> = null;
function check(condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

async function main() {
  // The scheduler's background verification/watchlist polling shares the
  // same local Ollama instance, which serializes requests — running this
  // test while it's active can stack document-generation behind several
  // other LLM calls and blow past a normal fetch timeout. Pause it for the
  // duration of the test, exactly like a real user would with "Pause" in
  // the Scheduler Health panel before doing interactive tailoring work.
  await fetch(`${BASE_URL}/api/scheduler/pause`, { method: "POST" }).catch(() => {});

  // ApplicationProfile is a real singleton the user fills in themselves on
  // the Documents page — back it up and restore it after the test so this
  // script never permanently overwrites real profile data with test values.
  originalProfile = await prisma.applicationProfile.findUnique({ where: { id: "default" } });

  console.log("1) Save application profile");
  const profileRes = await fetch(`${BASE_URL}/api/application-profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(JSON.parse(await readFile(path.join(process.cwd(), "scripts", "fixtures", "mock-candidates.json"), "utf8")).browserUploadSafe),
  });
  check(profileRes.ok, `profile saved (status ${profileRes.status})`);

  console.log("\n2) Generate bullet library from approved facts");
  const factCount = await prisma.resumeFact.count({
    where: { status: { in: ["approved", "edited"] }, type: { in: ["experience", "project", "activity"] } },
  });
  if (factCount === 0) {
    console.log("  SKIP: no approved experience/project/activity facts (run `npm run seed` first)");
  } else {
    const bulletsRes = await fetch(`${BASE_URL}/api/documents/bullets/generate`, { method: "POST" });
    const bulletsData = await bulletsRes.json();
    check(bulletsRes.ok, `bullet generation succeeded (status ${bulletsRes.status})`);
    check(bulletsData.count > 0, `at least one bullet generated (got ${bulletsData.count})`);

    const allBullets = await prisma.resumeBullet.findMany();
    const validFactIds = new Set(
      (await prisma.resumeFact.findMany({ where: { status: { in: ["approved", "edited"] } } })).map((f) => f.id),
    );
    const allGrounded = allBullets.every((b) => (JSON.parse(b.factIds) as string[]).every((id) => validFactIds.has(id)));
    check(allGrounded, "every bullet cites only real approved fact ids");
  }

  console.log("\n3) Generate tailored documents for a Pass-eligibility verified job");
  const facts = await prisma.resumeFact.findMany({ where: { status: { in: ["approved", "edited"] } } });
  if (facts.length === 0) {
    console.log("  SKIP: no approved facts at all");
  } else {
    await prisma.job.deleteMany({ where: { company: "Test Documents Co" } });
    const testJob = await prisma.job.create({
      data: {
        title: "Software Engineering Intern",
        company: "Test Documents Co",
        location: "Remote",
        description: "Looking for a Python and SQL intern pursuing a Computer Science degree.",
        url: `${BASE_URL}/mock-ats/full-job-description.html`,
        officialJobUrl: `${BASE_URL}/mock-ats/full-job-description.html`,
        officialApplyUrl: `${BASE_URL}/mock-ats/full-job-description.html`,
        status: "DISCOVERED",
        source: "manual",
        verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
        verificationMethod: "manual-entry",
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        lastVerifiedAt: new Date(),
      },
    });
    await prisma.matchResult.create({
      data: {
        jobId: testJob.id,
        eligibility: "Pass",
        eligibilityReason: "Meets stated requirements.",
        score: 88,
        explanation: "Strong match on Python/SQL/CS coursework.",
        recommendation: "Apply",
        skillsSupported: JSON.stringify([{
          skill: "Python",
          reason: "Supported by an approved resume fact in this isolated fixture.",
          factIds: [facts.find((fact) => /\bpython\b/i.test(`${fact.content} ${fact.detail ?? ""}`))?.id ?? facts[0].id],
        }]),
        skillsNeedConfirmation: JSON.stringify([]),
        skillsToLearn: JSON.stringify([{ skill: "Docker", reason: "Not yet used" }]),
        skillsNeverAdd: JSON.stringify([{ skill: "5 years professional experience", reason: "No evidence" }]),
        tailoringPreview: JSON.stringify(["Emphasize Python coursework."]),
        factsUsed: JSON.stringify([]),
      },
    });

    const genRes = await fetch(`${BASE_URL}/api/jobs/${testJob.id}/generate-documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ includeCoverLetter: true }),
    });
    const genData = await genRes.json();
    check(genRes.ok, `document generation succeeded (status ${genRes.status}, ${genRes.ok ? "" : JSON.stringify(genData)})`);

    if (genRes.ok) {
      check(genData.resume?.qaStatus === "pass", `resume QA passed (got ${genData.resume?.qaStatus}: ${JSON.stringify(genData.resume?.qaIssues)})`);
      check(!!genData.coverLetter, "cover letter was also generated (eligibility was Pass)");
      check(genData.coverLetter?.qaStatus === "pass", `cover-letter QA passed (got ${genData.coverLetter?.qaStatus}: ${JSON.stringify(genData.coverLetter?.qaIssues)})`);

      const resumeAbsPath = path.isAbsolute(genData.resume.storagePath)
        ? genData.resume.storagePath
        : path.join(process.cwd(), genData.resume.storagePath);
      const resumeBytes = await readFile(resumeAbsPath).catch(() => null);
      check(!!resumeBytes && resumeBytes.length > 0, "resume PDF file actually exists on disk");
      if (resumeBytes) {
        const extracted = await extractPdfText(new Uint8Array(resumeBytes));
        const text = extracted.text;
        check(extracted.pageCount === 1, "master-preserving resume is one page");
        check(text.indexOf("EXPERIENCE") < text.indexOf("PROJECTS") && text.indexOf("PROJECTS") < text.indexOf("SKILLS"), "fixed section order is Education, Experience, Projects, Skills");
        check(!text.includes("RELEVANT COURSEWORK"), "coursework is not emitted as a standalone section");
        check(text.includes("The UPS Store") && text.includes("Family Caregiver"), "all master experience entries are preserved");
        check(text.includes("Air Quality Monitor") && text.includes("Automated Plant-Watering System") && text.includes("Software-Defined Radio ADS-B Receiver"), "all master projects are preserved");
      }

      const doc = await prisma.generatedDocument.findUnique({ where: { id: genData.resume.id } });
      const classification = JSON.parse(doc?.keywordClassification ?? "{}");
      check(
        Array.isArray(classification.supported)
        && Array.isArray(classification.unsupported)
        && !JSON.stringify(classification).includes("5 years professional experience"),
        `keyword classification records only evidence-backed tailoring outcomes (got ${JSON.stringify(classification)})`,
      );

      const bulletIds = JSON.parse(doc?.bulletIdsUsed ?? "[]");
      check(Array.isArray(bulletIds), "bulletIdsUsed recorded for traceability");
    }

    console.log("\n4) Fail-eligibility jobs are refused (never tailor documents for jobs you don't qualify for)");
    await prisma.matchResult.create({
      data: {
        jobId: testJob.id,
        eligibility: "Fail",
        eligibilityReason: "Does not meet a hard requirement.",
        score: 10,
        explanation: "Ineligible.",
        recommendation: "Skip",
        skillsSupported: "[]",
        skillsNeedConfirmation: "[]",
        skillsToLearn: "[]",
        skillsNeverAdd: "[]",
        factsUsed: "[]",
      },
    });
    const failRes = await fetch(`${BASE_URL}/api/jobs/${testJob.id}/generate-documents`, { method: "POST" });
    check(failRes.status === 400, `generation refused for Fail-eligibility job (status ${failRes.status})`);

    console.log("\n5) Cleanup");
    await prisma.job.delete({ where: { id: testJob.id } });
    console.log("  done");
  }

  console.log(failures === 0 ? "\nAll document-generation tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Document generation test crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (originalProfile) {
      const { id, updatedAt, ...rest } = originalProfile;
      void id;
      void updatedAt;
      await prisma.applicationProfile.update({ where: { id: "default" }, data: rest }).catch(() => {});
    } else {
      await prisma.applicationProfile.delete({ where: { id: "default" } }).catch(() => {});
    }
    await fetch(`${BASE_URL}/api/scheduler/resume`, { method: "POST" }).catch(() => {});
    await prisma.$disconnect();
  });
