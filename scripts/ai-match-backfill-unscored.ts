import { prisma } from "@/lib/db";
import {
  backfillUnscoredInitialMatches,
  normalizeBackfillBatchSize,
} from "@/lib/matching/initialBackfill";

function optionValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const configuredBatch = optionValue("batch-size")
    ?? process.env.AI_MATCH_BACKFILL_BATCH_SIZE
    ?? "25";
  const batchSize = normalizeBackfillBatchSize(Number(configuredBatch));
  const dryRun = process.argv.includes("--dry-run");
  const counts = await backfillUnscoredInitialMatches({ batchSize, dryRun });
  console.log(JSON.stringify(counts));
}

main()
  .catch(() => {
    console.error(JSON.stringify({ error: "AI_MATCH_BACKFILL_FAILED" }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
