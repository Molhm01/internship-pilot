import { createClient } from "@libsql/client";

/**
 * Proves the accounts migration preserved everything it was not supposed to
 * touch. Run before and after; the counts must match exactly.
 */
const EXPECTED_TABLES = [
  "Job",
  "MatchResult",
  "GeneratedDocument",
  "ApplicationRun",
  "ResumeFact",
  "ApplicationProfile",
  "ApprovedAnswer",
];

const client = createClient({ url: process.env.DATABASE_URL ?? "file:./dev.db" });
const counts = {};
for (const table of EXPECTED_TABLES) {
  const result = await client.execute(`SELECT COUNT(*) AS n FROM "${table}"`);
  counts[table] = Number(result.rows[0].n);
}
const newTables = [
  "User",
  "UserSession",
  "UserProfile",
  "Education",
  "Experience",
  "Project",
  "ApplicationPreferences",
  "SensitiveAnswerPreferences",
];
for (const table of newTables) {
  const result = await client.execute(`SELECT COUNT(*) AS n FROM "${table}"`);
  counts[table] = Number(result.rows[0].n);
}
console.log(JSON.stringify(counts, null, 2));
