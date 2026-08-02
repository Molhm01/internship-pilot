import "dotenv/config";
import { prisma } from "@/lib/db";

async function diagnose() {
  console.log("=== Database Diagnosis ===");
  
  // 1. Check migrations table in dev.db
  const migrations = await prisma.$queryRawUnsafe<{ id: string; migration_name: string; finished_at: any }[]>(
    `SELECT id, migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at ASC`
  ).catch((e) => {
    console.error("Could not query _prisma_migrations:", e);
    return [];
  });

  console.log(`dev.db has ${migrations.length} migration record(s) applied:`);
  for (const m of migrations) {
    console.log(`  - ${m.migration_name} (finished: ${m.finished_at})`);
  }

  // 2. PRAGMA table_info for ApplicationRun
  const columns = await prisma.$queryRawUnsafe<{ cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[]>(
    `PRAGMA table_info('ApplicationRun')`
  );

  const actualColumns = columns.map(c => c.name);
  console.log(`\nActual ApplicationRun columns in dev.db (${actualColumns.length} total):`, actualColumns);

  // 3. Expected fields in ApplicationRun schema
  const expectedFields = [
    "id",
    "activeKey",
    "jobId",
    "mode",
    "atsType",
    "status",
    "currentStep",
    "stageHistory",
    "needsUserActionReason",
    "stoppedFieldLabel",
    "stoppedFieldType",
    "stoppedFieldOptions",
    "stoppedFieldStep",
    "stoppedFieldContext",
    "resumeDocumentId",
    "coverLetterDocumentId",
    "matchScoreAtRun",
    "answers",
    "confirmationNumber",
    "confirmationUrl",
    "attemptNumber",
    "attemptHistory",
    "errorCode",
    "validationPath",
    "protocolVersion",
    "schemaVersion",
    "tabRemainsOpen",
    "screenshotPath",
    "browserLogPath",
    "errorLog",
    "startedAt",
    "finishedAt",
    "createdAt",
    "updatedAt",
  ];

  const missingColumns = expectedFields.filter(f => !actualColumns.includes(f));
  console.log("\n=== MISSING COLUMNS IN ApplicationRun ===");
  if (missingColumns.length === 0) {
    console.log("ALL EXPECTED COLUMNS ARE PRESENT IN dev.db!");
  } else {
    console.log("MISSING COLUMNS:", missingColumns);
  }

  await prisma.$disconnect();
}

void diagnose();
