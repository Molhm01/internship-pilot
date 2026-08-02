import "dotenv/config";
import { prisma } from "@/lib/db";

export async function repairDatabaseSchema() {
  console.log("=== Repairing Database Schema (Idempotent) ===");

  const columns = await prisma.$queryRawUnsafe<{ cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[]>(
    `PRAGMA table_info('ApplicationRun')`
  );
  const existingColumnNames = new Set(columns.map(c => c.name));

  const columnsToAdd = [
    { name: "attemptNumber", sql: `ALTER TABLE "ApplicationRun" ADD COLUMN "attemptNumber" INTEGER NOT NULL DEFAULT 1` },
    { name: "attemptHistory", sql: `ALTER TABLE "ApplicationRun" ADD COLUMN "attemptHistory" TEXT` },
    { name: "errorCode", sql: `ALTER TABLE "ApplicationRun" ADD COLUMN "errorCode" TEXT` },
    { name: "validationPath", sql: `ALTER TABLE "ApplicationRun" ADD COLUMN "validationPath" TEXT` },
    { name: "protocolVersion", sql: `ALTER TABLE "ApplicationRun" ADD COLUMN "protocolVersion" INTEGER` },
    { name: "schemaVersion", sql: `ALTER TABLE "ApplicationRun" ADD COLUMN "schemaVersion" INTEGER` },
    { name: "tabRemainsOpen", sql: `ALTER TABLE "ApplicationRun" ADD COLUMN "tabRemainsOpen" BOOLEAN NOT NULL DEFAULT true` },
  ];

  let addedCount = 0;
  for (const col of columnsToAdd) {
    if (!existingColumnNames.has(col.name)) {
      console.log(`Adding missing column "${col.name}" to ApplicationRun...`);
      await prisma.$executeRawUnsafe(col.sql);
      addedCount += 1;
    }
  }

  console.log(`Database schema repair finished. Added ${addedCount} missing column(s).`);
}

if (process.argv[1]?.includes("repair-database-schema")) {
  void repairDatabaseSchema().then(() => prisma.$disconnect());
}
