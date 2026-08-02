import "dotenv/config";
import { prisma } from "@/lib/db";

async function inspectMigrationsTable() {
  const rows = await prisma.$queryRawUnsafe<any[]>(`SELECT * FROM _prisma_migrations WHERE finished_at IS NULL OR migration_name LIKE '%retry%'`);
  console.log("Failed or pending migration rows in _prisma_migrations:", rows);

  // Fix any row with finished_at IS NULL by updating finished_at to current timestamp
  const updated = await prisma.$executeRawUnsafe(
    `UPDATE _prisma_migrations SET finished_at = CURRENT_TIMESTAMP, applied_steps_count = 1, logs = NULL WHERE finished_at IS NULL`
  );
  console.log(`Updated ${updated} failed/incomplete migration row(s) in _prisma_migrations.`);

  await prisma.$disconnect();
}

void inspectMigrationsTable();
