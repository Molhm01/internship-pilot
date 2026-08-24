/**
 * Removes the narrowly identifiable dates written by the former Workday
 * `startDate` mapping. A job start date is not posting evidence.
 *
 * The signature is intentionally strict: Workday + employer ATS provenance +
 * no retained source text. The old adapter always produced exactly that shape.
 * Explicit Workday `postedOn`/date fields retain sourcePostedText and are not
 * touched. Re-running is idempotent.
 *
 * Usage:
 *   npm run repair:workday-source-dates             # inspect only
 *   npm run repair:workday-source-dates -- --apply  # bounded update
 */
import "dotenv/config";
import { pinCanonicalDatabaseUrl, announceCanonicalDatabase } from "./lib/canonicalDb";

const canonical = pinCanonicalDatabaseUrl();

import { prisma } from "@/lib/db";

const apply = process.argv.includes("--apply");
const BATCH_SIZE = 100;

async function main() {
  announceCanonicalDatabase(await prisma.job.count(), canonical);
  const rows = await prisma.job.findMany({
    where: {
      OR: [{ atsType: "workday" }, { source: "workday" }],
      sourcePostedAt: { not: null },
      sourcePostedText: null,
      sourceDateProvenance: { in: ["EMPLOYER_ATS_DATE", "EMPLOYER_ATS_EXACT"] },
    },
    orderBy: [{ sourcePostedAt: "desc" }, { id: "asc" }],
    select: { id: true, sourcePostedAt: true, postingDate: true },
  });

  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", contaminated: rows.length }));
  if (!apply) return;

  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    await prisma.$transaction(batch.map((row) => prisma.job.update({
      where: { id: row.id },
      data: {
        sourcePostedAt: null,
        sourcePostedText: null,
        sourceDateConfidence: "UNKNOWN",
        sourceDateProvenance: "UNKNOWN",
        // Clear the legacy mirror only when it is the same contaminated value.
        ...(row.postingDate?.getTime() === row.sourcePostedAt?.getTime() ? { postingDate: null } : {}),
      },
    })));
    console.log(`repaired ${Math.min(offset + batch.length, rows.length)}/${rows.length}`);
  }
}

main()
  .catch((error) => {
    console.error("[repair:workday-source-dates] failed", error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
