import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { extractPdfText } from "@/lib/pdf";
import { generateBulletLibrary } from "@/lib/documents/bulletLibrary";
import { generateDocumentsForJob } from "@/lib/documents/generate";
import { assertDisposablePostgres, announceDisposableDatabase } from "./lib/disposableDatabase";

/**
 * The document-generation contract, end to end: approved facts -> bullet
 * library -> tailored résumé and cover letter -> QA -> persisted rows.
 *
 * It creates its own account and its own approved facts. It used to POST to
 * `/api/application-profile` and read a singleton ApplicationProfile row, which
 * stopped being true when documents became user-scoped: the requests came back
 * 401 and the assertions ran against whatever facts happened to be in the local
 * database. Calling the same functions the routes call keeps the contract while
 * removing both the session plumbing and the dependency on a running server.
 *
 * Ollama has to be reachable — the bullet library and the tailoring pass are
 * real model calls. A missing model is reported as a failure, not skipped: the
 * point of this gate is that documents actually generate on this machine.
 */

const database = assertDisposablePostgres("test-documents");
announceDisposableDatabase("test-documents", database);

const PREFIX = "documents-audit";
const COMPANY = "Documents Audit Co";

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) console.log(`  PASS: ${message}`);
  else { console.error(`  FAIL: ${message}`); failures += 1; }
}

async function cleanup(): Promise<void> {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIX } }, select: { id: true } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  await prisma.job.deleteMany({ where: { company: COMPANY } });
}

/**
 * The facts a résumé is allowed to be built from. Tailoring may only reorder
 * and substitute against these, so they are also the evidence every later
 * grounding assertion is checked against.
 */
const APPROVED_FACTS = [
  { type: "experience", content: "PC Builder and Repair Technician, Freelance", detail: "Built 30+ custom PCs and completed 100+ hardware repairs; diagnosed and replaced RAM, SSDs, GPUs and cooling." },
  { type: "experience", content: "Sales Associate / Shift Lead, The UPS Store", detail: "Opening and closing procedures, register reconciliation, 20–30 customers per shift." },
  { type: "project", content: "Software-Defined Radio ADS-B Receiver", detail: "Python and RTL-SDR: captured raw IQ at 1090 MHz and demodulated Mode S frames, validated with CRC-24." },
  { type: "project", content: "Air Quality Monitor — VOC Detection", detail: "Sampled MQ-135 sensor data, filtered readings on an OLED, threshold-based alerts." },
  { type: "skill", content: "Python", detail: "Used in the ADS-B receiver and data-analysis coursework." },
  { type: "skill", content: "SQL", detail: "Used for coursework data sets." },
  { type: "activity", content: "IEEE Student Member", detail: "Attends chapter workshops." },
] as const;

async function createAuditUser() {
  const user = await prisma.user.create({
    data: { email: `${PREFIX}-owner@internship-pilot.invalid`, name: "Documents Owner", emailVerified: true },
  });
  await prisma.userProfile.create({
    data: {
      userId: user.id,
      legalFirstName: "Documents",
      legalLastName: "Owner",
      applicationEmail: `${PREFIX}-owner@internship-pilot.invalid`,
      phone: "+12025550123",
      city: "Newark",
      state: "NJ",
      country: "United States",
    },
  });
  await prisma.education.create({
    data: {
      userId: user.id,
      school: "New Jersey Institute of Technology",
      degree: "B.S.",
      major: "Electrical Engineering",
      graduationYear: "2029",
      sortOrder: 0,
    },
  });
  await prisma.resumeFact.createMany({
    data: APPROVED_FACTS.map((fact) => ({ ...fact, userId: user.id, status: "approved", source: "manual" })),
  });
  return user;
}

async function main(): Promise<void> {
  await cleanup();
  const user = await createAuditUser();
  const ownedFacts = await prisma.resumeFact.findMany({ where: { userId: user.id } });

  console.log("1) Bullet library is generated from this user's approved facts");
  const bullets = await generateBulletLibrary(user.id);
  check(bullets.count > 0, `at least one bullet generated (got ${bullets.count})`);

  const storedBullets = await prisma.resumeBullet.findMany({ where: { userId: user.id } });
  const ownedFactIds = new Set(ownedFacts.map((fact) => fact.id));
  check(storedBullets.length > 0, `bullets persisted for this user (got ${storedBullets.length})`);
  check(
    storedBullets.every((bullet) => (JSON.parse(bullet.factIds) as string[]).every((id) => ownedFactIds.has(id))),
    "every bullet cites only this user's approved fact ids",
  );
  const strayBullets = await prisma.resumeBullet.count({ where: { userId: { not: user.id } } });
  check(strayBullets === 0, `no bullets were written outside this user (got ${strayBullets})`);

  console.log("\n2) Tailored documents generate for a Pass-eligibility verified job");
  const job = await prisma.job.create({
    data: {
      title: "Software Engineering Intern",
      company: COMPANY,
      location: "Remote",
      description: "Looking for a Python and SQL intern pursuing a Computer Science or Electrical Engineering degree. "
        + "Responsibilities include writing scripts, working with data sets, and documenting results.",
      url: "https://boards.greenhouse.io/documentsaudit/jobs/1",
      officialJobUrl: "https://boards.greenhouse.io/documentsaudit/jobs/1",
      officialApplyUrl: "https://boards.greenhouse.io/documentsaudit/jobs/1",
      status: "DISCOVERED",
      source: "manual",
      verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
      verificationMethod: "manual-entry",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      lastVerifiedAt: new Date(),
    },
  });
  const pythonFact = ownedFacts.find((fact) => /\bpython\b/i.test(`${fact.content} ${fact.detail ?? ""}`)) ?? ownedFacts[0];
  await prisma.matchResult.create({
    data: {
      userId: user.id,
      jobId: job.id,
      eligibility: "Pass",
      eligibilityReason: "Meets stated requirements.",
      score: 88,
      explanation: "Strong match on Python/SQL coursework.",
      recommendation: "Apply",
      skillsSupported: JSON.stringify([{ skill: "Python", reason: "Supported by an approved resume fact in this isolated fixture.", factIds: [pythonFact.id] }]),
      skillsNeedConfirmation: JSON.stringify([]),
      skillsToLearn: JSON.stringify([{ skill: "Docker", reason: "Not yet used" }]),
      skillsNeverAdd: JSON.stringify([{ skill: "5 years professional experience", reason: "No evidence" }]),
      tailoringPreview: JSON.stringify(["Emphasize Python coursework."]),
      factsUsed: JSON.stringify([]),
    },
  });

  const generated = await generateDocumentsForJob(job.id, user.id, { includeCoverLetter: true });
  check(generated.resume.qaStatus === "pass", `resume QA passed (got ${generated.resume.qaStatus}: ${JSON.stringify(generated.resume.qaIssues)})`);
  check(!!generated.coverLetter, "cover letter was also generated (eligibility was Pass)");
  check(generated.coverLetter?.qaStatus === "pass", `cover-letter QA passed (got ${generated.coverLetter?.qaStatus}: ${JSON.stringify(generated.coverLetter?.qaIssues)})`);

  console.log("\n3) The résumé on disk is the master-preserving document");
  const resumeAbsPath = path.isAbsolute(generated.resume.storagePath)
    ? generated.resume.storagePath
    : path.join(process.cwd(), generated.resume.storagePath);
  const resumeBytes = await readFile(resumeAbsPath).catch(() => null);
  check(!!resumeBytes && resumeBytes.length > 0, "resume PDF file actually exists on disk");
  let resumeText: string | null = null;
  if (resumeBytes) {
    const extracted = await extractPdfText(new Uint8Array(resumeBytes));
    const text = extracted.text;
    resumeText = text;
    check(extracted.pageCount === 1, `master-preserving resume is one page (got ${extracted.pageCount})`);
    check(
      text.indexOf("EXPERIENCE") < text.indexOf("PROJECTS") && text.indexOf("PROJECTS") < text.indexOf("SKILLS"),
      "fixed section order is Education, Experience, Projects, Skills",
    );
    check(!text.includes("RELEVANT COURSEWORK"), "coursework is not emitted as a standalone section");
    check(text.includes("The UPS Store") && text.includes("Family Caregiver"), "all master experience entries are preserved");
    check(
      text.includes("Air Quality Monitor") && text.includes("Automated Plant-Watering System") && text.includes("Software-Defined Radio ADS-B Receiver"),
      "all master projects are preserved",
    );
  }

  console.log("\n4) The generated rows are owner-scoped and traceable");
  const doc = await prisma.generatedDocument.findUnique({ where: { id: generated.resume.id } });
  check(doc?.userId === user.id, "the generated résumé row belongs to the requesting user");
  const classification = JSON.parse(doc?.keywordClassification ?? "{}") as Record<string, unknown>;
  const supported = Array.isArray(classification.supported) ? classification.supported as string[] : null;
  const unsupported = Array.isArray(classification.unsupported) ? classification.unsupported as string[] : null;
  const NEVER_ADD = "5 years professional experience";
  check(!!supported && !!unsupported, `keyword classification has supported/unsupported lists (got ${JSON.stringify(classification)})`);
  check(supported?.includes("Python") === true, `an evidence-backed keyword is recorded as supported (got ${JSON.stringify(supported)})`);
  // The never-add claim belongs in `unsupported` — that list is the audit trail
  // showing it was considered and excluded. What must never happen is it being
  // promoted to `supported`, or reaching the document itself.
  check(unsupported?.includes(NEVER_ADD) === true, `a never-add claim is recorded as unsupported (got ${JSON.stringify(unsupported)})`);
  check(supported?.includes(NEVER_ADD) === false, "a never-add claim is never recorded as supported");
  check(resumeText !== null && !resumeText.toLowerCase().includes(NEVER_ADD.toLowerCase()), "the never-add claim does not appear in the résumé itself");
  const bulletIds = JSON.parse(doc?.bulletIdsUsed ?? "[]") as string[];
  const ownedBulletIds = new Set(storedBullets.map((bullet) => bullet.id));
  check(Array.isArray(bulletIds), "bulletIdsUsed recorded for traceability");
  check(bulletIds.every((id) => ownedBulletIds.has(id)), "every recorded bullet id belongs to this user's library");

  console.log("\n5) Fail-eligibility jobs are refused (never tailor documents you don't qualify for)");
  await prisma.matchResult.create({
    data: {
      userId: user.id,
      jobId: job.id,
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
  let refused = false;
  let refusalMessage = "generation was allowed";
  try {
    await generateDocumentsForJob(job.id, user.id, { includeCoverLetter: false });
  } catch (error) {
    refusalMessage = error instanceof Error ? error.message : String(error);
    refused = /eligibility is fail/i.test(refusalMessage);
  }
  check(refused, `generation refused for a Fail-eligibility job (${refusalMessage})`);

  console.log("\n6) Cleanup");
  await cleanup();
  console.log("  done");

  console.log(failures === 0 ? "\nAll document-generation tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Document generation test crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch(() => {});
    await prisma.$disconnect();
  });
