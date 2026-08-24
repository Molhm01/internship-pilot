import "dotenv/config";
import { prisma } from "@/lib/db";
import { hydrateMissingDescriptionsForScoring } from "@/lib/matching/jobDescriptionHydration";

const limitArg = process.argv.find((value) => value.startsWith("--limit="));
const concurrencyArg = process.argv.find((value) => value.startsWith("--concurrency="));
const maxItems = Number(limitArg?.split("=")[1] ?? 40);
const concurrency = Number(concurrencyArg?.split("=")[1] ?? 2);

hydrateMissingDescriptionsForScoring({ maxItems, concurrency })
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => { console.error("[hydrate-job-quality] failed", error); process.exitCode = 1; })
  .finally(() => void prisma.$disconnect());
