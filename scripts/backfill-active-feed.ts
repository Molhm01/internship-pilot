import "dotenv/config";
import { prisma } from "@/lib/db";
import { backfillActiveFeed } from "@/lib/jobs/activeFeed";

async function main(): Promise<void> {
  const before = await prisma.job.count({ where: { activeFeed: true } });
  const result = await backfillActiveFeed();
  const after = await prisma.job.count({ where: { activeFeed: true } });
  console.log(`Active-feed backfill: scanned ${result.scanned}, updated ${result.updated}.`);
  console.log(`Active jobs: ${before} -> ${after}.`);
  // Reassure that verification state was untouched.
  const byVerification = await prisma.job.groupBy({ by: ["verificationStatus"], _count: true });
  console.log("verificationStatus distribution (unchanged by this backfill):");
  for (const row of byVerification) console.log(`  ${row.verificationStatus}: ${row._count}`);
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
