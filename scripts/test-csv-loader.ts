import "dotenv/config";
import { prisma } from "@/lib/db";
import { parseApprovedEmployersCsv, csvFileExists } from "@/lib/employers/csv";
import { syncApprovedEmployersFromCsv } from "@/lib/employers/sync";

let failures = 0;
function check(condition: boolean, message: string) {
  if (condition) console.log(`  PASS: ${message}`);
  else { console.error(`  FAIL: ${message}`); failures++; }
}

const SAMPLE_CSV = `Employer,Sector,Careers / Jobs URL,Career Domain,EE/CPE Internship Fit,Verification Status,Verification Basis,Verified / Curated Date,Recommended Search Terms,Canonical Apply Rule
"Acme Aerospace, Inc.",Aerospace & Defense,https://careers.acme-aero.example/jobs,careers.acme-aero.example,Strong,Verified,"Manually confirmed careers page, 2026-01-10",2026-01-10,"electrical engineering intern, embedded intern","Apply only via careers.acme-aero.example or its linked Greenhouse board"
"Widget Robotics",Robotics,https://widgetrobotics.example/careers,widgetrobotics.example,Moderate,Verified,"Confirmed via LinkedIn company page cross-check",2026-01-12,"robotics intern, controls intern","Apply only via widgetrobotics.example"
`;

async function main() {
  console.log("1) CSV parser handles quoted fields with embedded commas correctly");
  const rows = parseApprovedEmployersCsv(SAMPLE_CSV);
  check(rows.length === 2, `parsed 2 data rows (got ${rows.length})`);
  check(rows[0].employer === "Acme Aerospace, Inc.", `quoted comma inside a field preserved correctly (got "${rows[0].employer}")`);
  check(rows[0].careerDomain === "careers.acme-aero.example", "career domain column parsed correctly");
  check(rows[0].recommendedSearchTerms === "electrical engineering intern, embedded intern", "recommended search terms containing commas parsed correctly");
  check(rows[1].employer === "Widget Robotics", "second row parsed correctly");

  console.log("\n2) Missing required columns are rejected clearly");
  let threw = false;
  try { parseApprovedEmployersCsv("Employer,Sector\nAcme,Aerospace\n"); }
  catch (error) { threw = error instanceof Error && /missing expected column/i.test(error.message); }
  check(threw, "malformed CSV throws a descriptive error");

  console.log("\n3) Authoritative CSV imports exactly 497 employers idempotently");
  const exists = await csvFileExists();
  check(exists, `data/approved_engineering_employers.csv exists (got exists=${exists})`);
  const syncResult = await syncApprovedEmployersFromCsv();
  check(syncResult.ran === true, `sync ran successfully (got ran=${syncResult.ran})`);
  check(syncResult.importedRows === 497, `sync imported exactly 497 employers (got ${syncResult.importedRows})`);
  check(syncResult.rejectedRows === 0 && syncResult.duplicateRows === 0, "no source rows were rejected or duplicated");
  const importedCount = await prisma.company.count({ where: { source: "csv", allowlisted: true } });
  check(importedCount === 497, `database contains exactly 497 active CSV employers (got ${importedCount})`);

  console.log(failures === 0 ? "\nAll CSV-loader tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures) process.exitCode = 1;
}

main().catch((error) => { console.error("CSV loader test crashed:", error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
