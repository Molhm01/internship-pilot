import { prisma } from "@/lib/db";
import { CSV_REL_PATH, EXPECTED_APPROVED_EMPLOYER_ROWS, csvFileExists, inspectApprovedEmployersCsv, type ApprovedEmployerRow } from "./csv";
import { logAudit } from "@/lib/applications/audit";

export type CsvSyncResult =
  | { ran: false; reason: "file_not_found" | "validation_failed"; sourceFilename: string; expectedRows: number; importedRows: number; rejectedRows: number; duplicateRows: number; errors: string[]; lastImportTime: string }
  | { ran: true; sourceFilename: string; expectedRows: number; totalRows: number; importedRows: number; rejectedRows: number; duplicateRows: number; errors: string[]; created: number; updated: number; deallowlisted: number; lastImportTime: string };

const IMPORT_STATUS_KEY = "approvedEmployerImportStatus";

async function saveImportStatus(result: CsvSyncResult) {
  await prisma.appSetting.upsert({ where: { key: IMPORT_STATUS_KEY }, update: { value: JSON.stringify(result) }, create: { key: IMPORT_STATUS_KEY, value: JSON.stringify(result) } });
}

export async function getApprovedEmployerImportStatus(): Promise<CsvSyncResult> {
  const saved = await prisma.appSetting.findUnique({ where: { key: IMPORT_STATUS_KEY } });
  if (saved) return JSON.parse(saved.value) as CsvSyncResult;
  return { ran: false, reason: "file_not_found", sourceFilename: CSV_REL_PATH, expectedRows: EXPECTED_APPROVED_EMPLOYER_ROWS, importedRows: 0, rejectedRows: 0, duplicateRows: 0, errors: [`Missing required source file: ${CSV_REL_PATH}`], lastImportTime: new Date(0).toISOString() };
}

function parseVerifiedDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * CSV ownership is intentionally narrow. Provider detection owns atsType,
 * atsIdentifier and every validation/telemetry field, so a routine registry
 * refresh must never reset a previously validated board to UNTESTED.
 */
export function approvedEmployerCsvUpdateData(row: ApprovedEmployerRow) {
  return {
    careersUrl: row.careersUrl,
    source: "csv",
    allowlisted: true,
    csvSector: row.sector,
    csvCareerDomain: row.careerDomain,
    csvEeCpeFit: row.eeCpeFit,
    csvVerificationStatus: row.verificationStatus,
    csvVerificationBasis: row.verificationBasis,
    csvVerifiedDate: parseVerifiedDate(row.verifiedDate),
    csvRecommendedSearchTerms: row.recommendedSearchTerms,
    csvCanonicalApplyRule: row.canonicalApplyRule,
    industry: row.sector,
  };
}

// Syncs the Company table from data/approved_engineering_employers.csv —
// this file is the ONLY thing (besides Intern List, and manually-added
// jobs) allowed to drive scheduled discovery. Rows no longer present in the
// CSV are flipped to allowlisted=false (excluded from scheduled checks)
// rather than deleted, so history/audit trail is never lost. Manual entries
// and user-approved Intern-List employers are never touched by this sync.
export async function syncApprovedEmployersFromCsv(): Promise<CsvSyncResult> {
  if (!(await csvFileExists())) {
    const result: CsvSyncResult = { ran: false, reason: "file_not_found", sourceFilename: CSV_REL_PATH, expectedRows: EXPECTED_APPROVED_EMPLOYER_ROWS, importedRows: 0, rejectedRows: 0, duplicateRows: 0, errors: [`Missing required source file: ${CSV_REL_PATH}`], lastImportTime: new Date().toISOString() };
    await saveImportStatus(result);
    return result;
  }

  const report = await inspectApprovedEmployersCsv();
  const rows = report.rows;
  if (rows.length !== EXPECTED_APPROVED_EMPLOYER_ROWS || report.rejectedRows > 0 || report.duplicateRows > 0) {
    const errors = [...report.errors];
    if (rows.length !== EXPECTED_APPROVED_EMPLOYER_ROWS) errors.unshift(`Expected ${EXPECTED_APPROVED_EMPLOYER_ROWS} unique valid employers; found ${rows.length}.`);
    const result: CsvSyncResult = { ran: false, reason: "validation_failed", sourceFilename: CSV_REL_PATH, expectedRows: EXPECTED_APPROVED_EMPLOYER_ROWS, importedRows: 0, rejectedRows: report.rejectedRows, duplicateRows: report.duplicateRows, errors, lastImportTime: new Date().toISOString() };
    await saveImportStatus(result);
    return result;
  }
  let created = 0;
  let updated = 0;

  const seenNames = new Set<string>();
  for (const row of rows) {
    seenNames.add(row.employer.trim().toLowerCase());
    const existing = await prisma.company.findUnique({ where: { name: row.employer } });

    const data = approvedEmployerCsvUpdateData(row);

    if (existing) {
      await prisma.company.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.company.create({
        data: {
          name: row.employer,
          atsType: "unknown",
          priority: "standard",
          ...data,
        },
      });
      created++;
    }
  }

  // De-allowlist any company not in the current CSV — including legacy
  // "seed"/"discovered" rows from before this strict two-source rule
  // existed. Manual entries and user-approved Intern-List employers are the
  // only other allowed discovery sources, so they're exempt. Nothing is
  // ever deleted — de-allowlisted companies just stop being actively
  // checked, and remain visible (with history) on the Watchlist page.
  const candidatesToRecheck = await prisma.company.findMany({
    where: { source: { in: ["csv", "seed", "discovered"] }, allowlisted: true },
    select: { id: true, name: true },
  });
  let deallowlisted = 0;
  for (const c of candidatesToRecheck) {
    if (!seenNames.has(c.name.trim().toLowerCase())) {
      await prisma.company.update({ where: { id: c.id }, data: { allowlisted: false } });
      deallowlisted++;
    }
  }

  await logAudit({
    actor: "verification",
    action: "csv-allowlist-synced",
    detail: `Synced ${rows.length} row(s) from approved_engineering_employers.csv: ${created} created, ${updated} updated, ${deallowlisted} de-allowlisted (removed from the CSV).`,
  });

  const result: CsvSyncResult = { ran: true, sourceFilename: CSV_REL_PATH, expectedRows: EXPECTED_APPROVED_EMPLOYER_ROWS, totalRows: rows.length, importedRows: rows.length, rejectedRows: report.rejectedRows, duplicateRows: report.duplicateRows, errors: report.errors, created, updated, deallowlisted, lastImportTime: new Date().toISOString() };
  await saveImportStatus(result);
  return result;
}

export type { ApprovedEmployerRow };
