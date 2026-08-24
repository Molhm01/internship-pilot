import "dotenv/config";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) console.log(`  PASS: ${message}`);
  else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

const SAMPLE_CSV = `Employer,Sector,Careers / Jobs URL,Career Domain,EE/CPE Internship Fit,Verification Status,Verification Basis,Verified / Curated Date,Recommended Search Terms,Canonical Apply Rule
"Acme Aerospace, Inc.",Aerospace & Defense,https://careers.acme-aero.example/jobs,careers.acme-aero.example,Strong,Verified,"Manually confirmed careers page, 2026-01-10",2026-01-10,"electrical engineering intern, embedded intern","Apply only via careers.acme-aero.example or its linked Greenhouse board"
"Widget Robotics",Robotics,https://widgetrobotics.example/careers,widgetrobotics.example,Moderate,Verified,"Confirmed via official company page",2026-01-12,"robotics intern, controls intern","Apply only via widgetrobotics.example"
`;

function authoritativeFixtureCsv(): string {
  const header = "Employer,Sector,Careers / Jobs URL,Career Domain,EE/CPE Internship Fit,Verification Status,Verification Basis,Verified / Curated Date,Recommended Search Terms,Canonical Apply Rule";
  const rows = Array.from({ length: 497 }, (_, index) => {
    const n = String(index + 1).padStart(3, "0");
    return `Audit Employer ${n},Audit Engineering,https://audit-employer-${n}.example/careers,audit-employer-${n}.example,High,Official career portal,CI fixture,2026-08-22,internship,Apply only via official fixture portal`;
  });
  return [header, ...rows].join("\n") + "\n";
}

async function main() {
  // Point the importer at a disposable fixture before dynamically importing the
  // module that captures CSV_REL_PATH. Never overwrite the user's real local
  // data/approved_engineering_employers.csv.
  const fixtureRelPath = ".internship-pilot-audit/approved_engineering_employers.csv";
  process.env.APPROVED_EMPLOYERS_CSV_PATH = fixtureRelPath;
  const [{ parseApprovedEmployersCsv, csvFileExists }, { syncApprovedEmployersFromCsv }] = await Promise.all([
    import("@/lib/employers/csv"),
    import("@/lib/employers/sync"),
  ]);

  console.log("1) CSV parser handles quoted fields with embedded commas correctly");
  const rows = parseApprovedEmployersCsv(SAMPLE_CSV);
  check(rows.length === 2, `parsed 2 data rows (got ${rows.length})`);
  check(rows[0].employer === "Acme Aerospace, Inc.", `quoted comma inside a field preserved correctly (got "${rows[0].employer}")`);
  check(rows[0].careerDomain === "careers.acme-aero.example", "career domain column parsed correctly");
  check(rows[0].recommendedSearchTerms === "electrical engineering intern, embedded intern", "recommended search terms containing commas parsed correctly");
  check(rows[1].employer === "Widget Robotics", "second row parsed correctly");

  console.log("\n2) Missing required columns are rejected clearly");
  let threw = false;
  try {
    parseApprovedEmployersCsv("Employer,Sector\nAcme,Aerospace\n");
  } catch (error) {
    threw = error instanceof Error && /missing expected column/i.test(error.message);
  }
  check(threw, "malformed CSV throws a descriptive error");

  console.log("\n3) Importer accepts exactly 497 unique validated employers idempotently");
  // Same declaration the destructive fixtures use (scripts/lib/disposableDatabase.ts):
  // a disposable name, or an explicit ISOLATED_TEST_MODE=1 from the operator.
  // The name alone is not always available — a local Prisma Dev instance serves
  // one database called "template1" whatever name the URL asks for, so
  // isolation there means a separate `prisma dev --name` instance, and the
  // operator has to be the one to say so.
  const safeDatabase = process.env.CI === "true"
    || process.env.ISOLATED_TEST_MODE === "1"
    || /(?:audit|test)/i.test(process.env.DATABASE_URL ?? "");
  if (!safeDatabase) {
    console.log("  SKIP: database integration portion requires CI, ISOLATED_TEST_MODE=1, or a DATABASE_URL containing 'audit'/'test' to protect real local data.");
  } else {
    const fixtureAbsPath = path.join(process.cwd(), fixtureRelPath);
    await mkdir(path.dirname(fixtureAbsPath), { recursive: true });
    await writeFile(fixtureAbsPath, authoritativeFixtureCsv(), "utf8");
    try {
      check(await csvFileExists(), "disposable 497-row fixture exists");
      const first = await syncApprovedEmployersFromCsv();
      check(first.ran === true, `first sync ran successfully (got ran=${first.ran})`);
      check(first.importedRows === 497, `first sync imported exactly 497 employers (got ${first.importedRows})`);
      check(first.rejectedRows === 0 && first.duplicateRows === 0, "no fixture rows were rejected or duplicated");
      const importedCount = await prisma.company.count({ where: { source: "csv", allowlisted: true } });
      check(importedCount === 497, `database contains exactly 497 active CSV employers (got ${importedCount})`);

      const second = await syncApprovedEmployersFromCsv();
      check(second.ran === true && second.created === 0 && second.updated === 497, "second sync is idempotent (0 create, 497 update)");
    } finally {
      await prisma.company.deleteMany({ where: { name: { startsWith: "Audit Employer " } } });
      await prisma.appSetting.deleteMany({ where: { key: "approvedEmployerImportStatus" } });
      await rm(path.join(process.cwd(), ".internship-pilot-audit"), { recursive: true, force: true });
    }
  }

  console.log(failures === 0 ? "\nAll CSV-loader tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("CSV loader test crashed:", error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
