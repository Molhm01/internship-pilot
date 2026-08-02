import "dotenv/config";
import { prisma } from "@/lib/db";

async function inspectSchemaDrift() {
  console.log("=== Phase 1: Database Schema Drift Inspection ===");
  
  const columns = await prisma.$queryRawUnsafe<{ cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[]>(
    `PRAGMA table_info('ApplicationRun')`
  );
  
  const actualColumnNames = columns.map(c => c.name);
  console.log("Actual ApplicationRun columns in dev.db:", actualColumnNames);

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

  const missingColumns = expectedFields.filter(f => !actualColumnNames.includes(f));

  console.log("\n=== SCHEMA DRIFT REPORT ===");
  if (missingColumns.length === 0) {
    console.log("No missing columns in ApplicationRun.");
  } else {
    console.log(`Missing ${missingColumns.length} expected column(s) in dev.db:`, missingColumns);
  }

  await prisma.$disconnect();
}

void inspectSchemaDrift();
