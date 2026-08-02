/**
 * Backfill Job.sourcePostedAt for records ingested before the canonical field
 * existed.
 *
 * Two hard rules, per the freshness requirements:
 *
 *  1. Nothing is invented. The only source of a backfilled timestamp is the
 *     value this app ALREADY stored from the source (`postingDate`). A row with
 *     no stored source date is marked UNKNOWN and sorts after known-date jobs —
 *     it is never given `createdAt`, `firstSeenAt` or "now" as a stand-in,
 *     because that is precisely how a stale record starts looking fresh.
 *  2. Nothing is deleted or overwritten. No job, score, or document is removed,
 *     and a row that already has a sourcePostedAt is left alone.
 *
 * Confidence is derived from the precision the stored value actually carries:
 *   EXACT      — a real instant (has a time-of-day component)
 *   DATE_ONLY  — midnight-aligned, so the source only ever claimed a day
 *   UNKNOWN    — no stored source date at all
 *
 * Usage:
 *   npm run backfill:source-posted-at            # apply
 *   npm run backfill:source-posted-at -- --dry-run
 */

import "dotenv/config";
import { prisma } from "@/lib/db";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const rows = await prisma.job.findMany({
    where: { sourcePostedAt: null },
    select: {
      id: true,
      source: true,
      postingDate: true,
      firstSeenAt: true,
      createdAt: true,
      sourcePostedText: true,
    },
  });

  console.log(`Jobs without sourcePostedAt: ${rows.length}${dryRun ? " (dry run)" : ""}`);

  const counts = { EXACT: 0, DATE_ONLY: 0, UNKNOWN: 0 };

  for (const row of rows) {
    const posted = row.postingDate;
    const confidence = !posted
      ? "UNKNOWN"
      : posted.getTime() % 86_400_000 === 0
        ? "DATE_ONLY"
        : "EXACT";
    counts[confidence] += 1;

    if (dryRun) continue;

    await prisma.job.update({
      where: { id: row.id },
      data: {
        sourcePostedAt: posted,
        sourceDateConfidence: confidence,
        // The capture time we can defend is when this app first saw the row.
        // It is recorded as capture context only — never as the posting date.
        sourceCapturedAt: row.firstSeenAt ?? row.createdAt,
        ...(confidence === "UNKNOWN" && !row.sourcePostedText
          ? { sourcePostedText: null }
          : {}),
      },
    });
  }

  console.log(`  EXACT      ${counts.EXACT}`);
  console.log(`  DATE_ONLY  ${counts.DATE_ONLY}`);
  console.log(`  UNKNOWN    ${counts.UNKNOWN}   (shown as "Posting date unknown", sorted last)`);

  const remaining = await prisma.job.count({ where: { sourcePostedAt: null } });
  console.log(`Jobs still without a known source posting date: ${remaining}`);
}

main()
  .catch((error) => {
    console.error("[backfill:source-posted-at] failed", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
