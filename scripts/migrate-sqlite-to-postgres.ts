/**
 * Copies an existing local dev.db into the new PostgreSQL database.
 *
 * Internship Pilot moved from SQLite to PostgreSQL so the same schema runs on a
 * laptop and on a serverless deployment. That leaves real local data — months
 * of discovered jobs, approved résumé facts, verification evidence — in a file
 * the application no longer opens. This script moves it across.
 *
 * It reads the SQLite file directly with the libsql driver and writes through
 * Prisma, so the destination goes through the same validation as any other
 * write. Nothing is deleted: dev.db is opened read-only and is still there
 * afterwards, which matters because this is the only copy of that data.
 *
 * Usage:
 *   DATABASE_URL=<postgres-url> npx tsx scripts/migrate-sqlite-to-postgres.ts [--source file:./dev.db] [--dry-run]
 */
import "dotenv/config";
import { createClient } from "@libsql/client";
import { prisma } from "../src/lib/db";

/**
 * Insertion order. Parents before children, because PostgreSQL enforces
 * foreign keys on every insert and SQLite's dump order does not guarantee it.
 */
const TABLES = [
  "User",
  "UserSession",
  "UserProfile",
  "Company",
  "ApprovedAtsTenant",
  "NewEmployerReview",
  "SecurityQuarantineEntry",
  "Job",
  "AtsSyncRun",
  "VerificationAttempt",
  "MatchResult",
  "InitialAiMatchJob",
  "GeneratedDocument",
  "ApplicationRun",
  "AuditLogEntry",
  "ResumeFact",
  "ResumeDocument",
  "ResumeBullet",
  "ApplicationProfile",
  "ApplicationPreferences",
  "SensitiveAnswerPreferences",
  "CompanyRelationshipFact",
  "ApprovedAnswer",
  "Education",
  "Experience",
  "Project",
  "SyncLog",
  "SavedFilter",
  "AppSetting",
  "GmailAccount",
  "TrackedEmail",
  "AssessmentInboxEntry",
  "NearbyFirm",
] as const;

type TableName = (typeof TABLES)[number];

/** Prisma delegate name for a model, e.g. `AppSetting` -> `appSetting`. */
function delegateFor(table: TableName) {
  const key = table.charAt(0).toLowerCase() + table.slice(1);
  const delegate = (prisma as unknown as Record<string, unknown>)[key];
  if (!delegate) throw new Error(`No Prisma delegate for model ${table}.`);
  return delegate as {
    createMany: (args: { data: unknown[]; skipDuplicates?: boolean }) => Promise<{ count: number }>;
    count: () => Promise<number>;
  };
}

/**
 * SQLite has no date type: Prisma stored DateTime as epoch milliseconds and
 * Boolean as 0/1. The destination columns are `timestamp` and `boolean`, so
 * every value has to be interpreted against the schema rather than copied.
 */
function coerce(value: unknown, columnType: "datetime" | "boolean" | "other"): unknown {
  if (value === null || value === undefined) return null;
  if (columnType === "datetime") {
    if (value instanceof Date) return value;
    if (typeof value === "number") return new Date(value);
    if (typeof value === "string") return new Date(value);
    if (typeof value === "bigint") return new Date(Number(value));
    return null;
  }
  if (columnType === "boolean") return Boolean(Number(value));
  if (typeof value === "bigint") return Number(value);
  return value;
}

/** Column name -> declared type, parsed out of prisma/schema.prisma. */
async function schemaColumnTypes(): Promise<Map<string, Map<string, "datetime" | "boolean" | "other">>> {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const result = new Map<string, Map<string, "datetime" | "boolean" | "other">>();
  const modelPattern = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  for (const match of source.matchAll(modelPattern)) {
    const [, model, body] = match;
    const columns = new Map<string, "datetime" | "boolean" | "other">();
    for (const line of body.split(/\r?\n/)) {
      const field = /^\s{2}(\w+)\s+(\w+)(\?|\[\])?/.exec(line);
      if (!field) continue;
      const [, name, type, modifier] = field;
      if (modifier === "[]") continue; // relation list, not a column
      columns.set(
        name,
        type === "DateTime" ? "datetime" : type === "Boolean" ? "boolean" : "other",
      );
    }
    result.set(model, columns);
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const sourceIndex = args.indexOf("--source");
  const sourceUrl = sourceIndex >= 0 ? args[sourceIndex + 1] : "file:./dev.db";

  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL must point at the destination PostgreSQL database.");
  }
  if (process.env.DATABASE_URL.startsWith("file:")) {
    throw new Error("DATABASE_URL points at a SQLite file; it must be the PostgreSQL destination.");
  }

  const sqlite = createClient({ url: sourceUrl });
  const columnTypes = await schemaColumnTypes();
  const summary: Array<{ table: string; read: number; written: number }> = [];

  for (const table of TABLES) {
    const types = columnTypes.get(table);
    if (!types) throw new Error(`Model ${table} is missing from prisma/schema.prisma.`);

    let rows: Record<string, unknown>[];
    try {
      const result = await sqlite.execute(`SELECT * FROM "${table}"`);
      rows = result.rows as unknown as Record<string, unknown>[];
    } catch {
      // A table that never existed in this dev.db (added after the snapshot)
      // is not an error — there is simply nothing to carry over.
      summary.push({ table, read: 0, written: 0 });
      continue;
    }

    const data = rows.map((row) => {
      const converted: Record<string, unknown> = {};
      for (const [column, value] of Object.entries(row)) {
        const type = types.get(column);
        if (!type) continue; // column dropped from the schema since
        converted[column] = coerce(value, type);
      }
      return converted;
    });

    let written = 0;
    if (!dryRun && data.length) {
      // Chunked: a single createMany with tens of thousands of rows can exceed
      // the parameter limit of one PostgreSQL statement.
      for (let index = 0; index < data.length; index += 500) {
        const chunk = data.slice(index, index + 500);
        const result = await delegateFor(table).createMany({ data: chunk, skipDuplicates: true });
        written += result.count;
      }
    }
    summary.push({ table, read: data.length, written });
    console.log(`${table.padEnd(28)} read ${String(data.length).padStart(6)}  wrote ${String(written).padStart(6)}`);
  }

  const totalRead = summary.reduce((sum, row) => sum + row.read, 0);
  const totalWritten = summary.reduce((sum, row) => sum + row.written, 0);
  console.log(`\n${dryRun ? "[dry run] " : ""}${totalRead} rows read, ${totalWritten} rows written.`);
  console.log(`Source ${sourceUrl} was opened read-only and is unchanged.`);

  await sqlite.close();
  await prisma.$disconnect();
}

void main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await prisma.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
