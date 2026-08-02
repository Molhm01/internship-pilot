import "dotenv/config";
import { prisma } from "@/lib/db";
import { stripRepeatedPrefixes } from "@/lib/jobs/verificationAttempt";
import { recomputeJobActiveFeed } from "@/lib/jobs/activeFeed";
import { isTrustedAggregatorSource, canonicalizeSource } from "@/lib/jobs/sourcePolicy";

// Idempotent repair for the false-closure bug.
//
// The old verifier marked a job POSTING_CLOSED / CLOSED_OR_UNVERIFIED whenever
// it could not find a matching Greenhouse/Lever/Ashby posting. Those are only
// three of many ATS providers, so that was never evidence of closure. This
// script:
//   1. Clears that incorrect closed state and moves the job back into the feed
//      as ACTIVE_SOURCE_LISTED (only when the mirror rule was its ONLY closure
//      evidence).
//   2. Leaves genuinely-closed and security-blocked records untouched.
//   3. Strips any recursively-prepended "CODE: CODE: ..." reason on every row.
// Safe to run any number of times.

// The exact sentinel text the obsolete ATS-mirror rule wrote.
const MIRROR_RULE = /could not independently locate a matching official greenhouse|no matching greenhouse\/lever\/ashby posting was found|per the strict discovery boundary, this is treated as closed/i;
// Genuine closure evidence that must NOT be reverted.
const GENUINE_CLOSURE = /http\s*4(0[49]|10)|\bgone\b|no longer available|posting is confirmed closed|position (has been )?filled|expired/i;

async function main() {
  const jobs = await prisma.job.findMany();
  let examined = 0;
  let falseClosedRepaired = 0;
  let genuinelyClosedRetained = 0;
  let securityRetained = 0;
  let prefixesStripped = 0;
  let missingDestinationUrl = 0;
  const duplicatesMerged = 0; // dedup is handled at ingest; none created/merged here

  for (const job of jobs) {
    examined++;
    const reason = job.verificationReason ?? "";
    const wasClosed = job.verificationStatus === "Closed" || job.verificationStatus === "CLOSED_OR_UNVERIFIED";
    const fromMirrorRule = MIRROR_RULE.test(reason);
    const hasGenuineClosure = GENUINE_CLOSURE.test(reason);

    // 1. Strip recursive prefixes on every row (idempotent).
    const cleaned = stripRepeatedPrefixes(reason);

    if (job.verificationStatus === "SecurityQuarantine") {
      securityRetained++;
      if (cleaned !== reason) {
        await prisma.job.update({ where: { id: job.id }, data: { verificationReason: cleaned } });
        prefixesStripped++;
      }
      continue;
    }

    if (wasClosed && fromMirrorRule && !hasGenuineClosure) {
      // Repair: this was only closed because no ATS mirror was found.
      const isTrusted = isTrustedAggregatorSource(job.source) || canonicalizeSource(job.source) === "manual";
      const newReason = isTrusted
        ? "Listed on the discovery source. No Greenhouse/Lever/Ashby mirror was found, but those are only three of many ATS providers, so this is not treated as closed. Official destination not yet independently confirmed."
        : "No Greenhouse/Lever/Ashby mirror found; not treated as closed. Official destination not yet independently confirmed.";
      await prisma.job.update({
        where: { id: job.id },
        data: {
          verificationStatus: "ACTIVE_SOURCE_LISTED",
          reasonCode: "OFFICIAL_MIRROR_NOT_FOUND",
          verificationReason: newReason,
          // Do NOT touch url/sourceUrl/officialApplyUrl/company/title/location/timestamps.
        },
      });
      await recomputeJobActiveFeed(job.id);
      falseClosedRepaired++;
      if (!job.url && !job.sourceUrl && !job.officialApplyUrl) missingDestinationUrl++;
      continue;
    }

    if (wasClosed) {
      // Genuine closure (or a closure from some other real signal) — keep it.
      genuinelyClosedRetained++;
      if (cleaned !== reason) {
        await prisma.job.update({ where: { id: job.id }, data: { verificationReason: cleaned, reasonCode: job.reasonCode ?? "CLOSED_NOT_FOUND" } });
        prefixesStripped++;
      }
      continue;
    }

    // Non-closed rows: just clean any recursive prefix.
    if (cleaned !== reason) {
      await prisma.job.update({ where: { id: job.id }, data: { verificationReason: cleaned } });
      prefixesStripped++;
    }
    if (!job.url && !job.sourceUrl && !job.officialApplyUrl) missingDestinationUrl++;
  }

  console.log("=== Verification-state repair summary ===");
  console.log(`records examined:                 ${examined}`);
  console.log(`false closed states repaired:     ${falseClosedRepaired}`);
  console.log(`genuinely closed records retained:${genuinelyClosedRetained}`);
  console.log(`security-blocked records retained:${securityRetained}`);
  console.log(`recursive-prefix reasons cleaned: ${prefixesStripped}`);
  console.log(`duplicates merged:                ${duplicatesMerged}`);
  console.log(`records missing any destination URL:${missingDestinationUrl}`);

  const active = await prisma.job.count({ where: { activeFeed: true } });
  const inactive = await prisma.job.count({ where: { activeFeed: false } });
  console.log(`\nactiveFeed=true: ${active}   activeFeed=false: ${inactive}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
