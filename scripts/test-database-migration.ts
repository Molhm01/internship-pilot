import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "@/generated/prisma/client";

async function testDatabaseMigrationFromZero() {
  console.log("=== Regression Test: Create Database From Zero & Apply All Migrations ===");
  
  const testDbFile = path.join(process.cwd(), `test-migration-zero-${Date.now()}.db`);
  const dbUrl = `file:${testDbFile}`;

  try {
    // Run prisma migrate deploy on clean DB file
    console.log(`Creating fresh SQLite database: ${testDbFile}`);
    execSync(`npx prisma migrate deploy`, {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "pipe",
    });
    console.log("PASS: All Prisma migrations applied cleanly to zero database.");

    // Connect to fresh database and query all ApplicationRun fields
    const adapter = new PrismaLibSql({ url: dbUrl });
    const prisma = new PrismaClient({ adapter });

    // Verify ApplicationRun fields queryable
    const runs = await prisma.applicationRun.findMany({ take: 1 });
    console.log(`PASS: Successfully queried ApplicationRun table from fresh migration DB (${runs.length} rows).`);

    // Query PRAGMA table_info to confirm attemptNumber and all retry fields exist
    const columns = await prisma.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info('ApplicationRun')`);
    const columnNames = new Set(columns.map((c) => c.name));

    const requiredFields = [
      "attemptNumber",
      "attemptHistory",
      "errorCode",
      "validationPath",
      "protocolVersion",
      "schemaVersion",
      "tabRemainsOpen",
    ];

    for (const field of requiredFields) {
      if (!columnNames.has(field)) {
        throw new Error(`FAIL: Missing field '${field}' in fresh ApplicationRun table!`);
      }
    }
    console.log(`PASS: Confirmed all 7 retry fields (${requiredFields.join(", ")}) exist in fresh database schema.`);

    await prisma.$disconnect();
    console.log("\nAll Phase 1 Database Migration tests PASSED.");
  } finally {
    if (fs.existsSync(testDbFile)) {
      try {
        fs.unlinkSync(testDbFile);
      } catch {
        // Ignored
      }
    }
  }
}

void testDatabaseMigrationFromZero();
