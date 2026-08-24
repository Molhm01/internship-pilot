import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";

// Production/local defaults to the user's curated data file. Diagnostics may
// point this at a disposable fixture so a parser/import test can never overwrite
// or depend on the real 497-employer source file.
export const CSV_REL_PATH = process.env.APPROVED_EMPLOYERS_CSV_PATH?.trim() || "data/approved_engineering_employers.csv";

function absolute(relativePath: string): string {
  return path.isAbsolute(relativePath)
    ? relativePath
    : path.join(/* turbopackIgnore: true */ process.cwd(), relativePath);
}

// Minimal RFC4180-ish CSV parser: handles quoted fields, escaped quotes
// (""), commas/newlines inside quotes. Hand-rolled rather than adding a
// dependency for something this small — real-world CSV exports commonly
// have commas inside URLs/notes fields, so a naive split(",") would corrupt
// rows silently, which is unacceptable for an allowlist file.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  while (i < normalized.length) {
    const char = normalized[i];
    if (inQuotes) {
      if (char === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += char;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

const EXPECTED_HEADERS = [
  "Employer",
  "Sector",
  "Careers / Jobs URL",
  "Career Domain",
  "EE/CPE Internship Fit",
  "Verification Status",
  "Verification Basis",
  "Verified / Curated Date",
  "Recommended Search Terms",
  "Canonical Apply Rule",
] as const;
export const EXPECTED_APPROVED_EMPLOYER_ROWS = 497;

export const approvedEmployerSchema = z.object({
  employer: z.string().trim().min(1),
  sector: z.string().trim().nullable(),
  careersUrl: z.string().trim().nullable(),
  careerDomain: z.string().trim().nullable(),
  eeCpeFit: z.string().trim().nullable(),
  verificationStatus: z.string().trim().nullable(),
  verificationBasis: z.string().trim().nullable(),
  verifiedDate: z.string().trim().nullable(),
  recommendedSearchTerms: z.string().trim().nullable(),
  canonicalApplyRule: z.string().trim().nullable(),
});
export type ApprovedEmployerRow = z.infer<typeof approvedEmployerSchema>;

export class CsvFormatError extends Error {}

export type ApprovedEmployerCsvReport = {
  rows: ApprovedEmployerRow[];
  sourceRows: number;
  rejectedRows: number;
  duplicateRows: number;
  errors: string[];
};

function emptyToNull(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : null;
}

export function parseApprovedEmployersCsvDetailed(text: string): ApprovedEmployerCsvReport {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new CsvFormatError("CSV file is empty.");

  const header = rows[0].map((h) => h.trim());
  const missing = EXPECTED_HEADERS.filter((h) => !header.includes(h));
  if (missing.length > 0) {
    throw new CsvFormatError(`CSV is missing expected column(s): ${missing.join(", ")}`);
  }
  const idx = (name: string) => header.indexOf(name);

  const out: ApprovedEmployerRow[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  let rejectedRows = 0;
  let duplicateRows = 0;
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    if (cols.every((c) => c.trim() === "")) continue;
    const record = {
      employer: emptyToNull(cols[idx("Employer")]) ?? "",
      sector: emptyToNull(cols[idx("Sector")]),
      careersUrl: emptyToNull(cols[idx("Careers / Jobs URL")]),
      careerDomain: emptyToNull(cols[idx("Career Domain")]),
      eeCpeFit: emptyToNull(cols[idx("EE/CPE Internship Fit")]),
      verificationStatus: emptyToNull(cols[idx("Verification Status")]),
      verificationBasis: emptyToNull(cols[idx("Verification Basis")]),
      verifiedDate: emptyToNull(cols[idx("Verified / Curated Date")]),
      recommendedSearchTerms: emptyToNull(cols[idx("Recommended Search Terms")]),
      canonicalApplyRule: emptyToNull(cols[idx("Canonical Apply Rule")]),
    };
    const parsed = approvedEmployerSchema.safeParse(record);
    if (!parsed.success || !parsed.data.employer.length) {
      rejectedRows++;
      errors.push(`Row ${r + 1}: ${parsed.success ? "Employer is blank." : parsed.error.issues.map((issue) => issue.message).join("; ")}`);
      continue;
    }
    const key = parsed.data.employer.toLocaleLowerCase();
    if (seen.has(key)) {
      duplicateRows++;
      errors.push(`Row ${r + 1}: duplicate employer "${parsed.data.employer}".`);
      continue;
    }
    seen.add(key);
    out.push(parsed.data);
  }
  return { rows: out, sourceRows: rows.length - 1, rejectedRows, duplicateRows, errors };
}

export function parseApprovedEmployersCsv(text: string): ApprovedEmployerRow[] {
  return parseApprovedEmployersCsvDetailed(text).rows;
}

export async function csvFileExists(): Promise<boolean> {
  try {
    await readFile(absolute(CSV_REL_PATH));
    return true;
  } catch {
    return false;
  }
}

export async function loadApprovedEmployersCsv(): Promise<ApprovedEmployerRow[]> {
  const text = await readFile(absolute(CSV_REL_PATH), "utf-8");
  return parseApprovedEmployersCsv(text);
}

export async function inspectApprovedEmployersCsv(): Promise<ApprovedEmployerCsvReport> {
  const text = await readFile(absolute(CSV_REL_PATH), "utf-8");
  return parseApprovedEmployersCsvDetailed(text);
}
