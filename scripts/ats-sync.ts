// Primary ingestion: pull internships directly from employers' official
// Greenhouse / Lever / Ashby job boards.
//
//   npm run ats:sync -- --dry-run
//   npm run ats:sync -- --apply
//   npm run ats:sync -- --apply --limit=25
//   npm run ats:sync -- --apply --vendors=greenhouse,lever

import { prisma } from "@/lib/db";
import type { ResolvableAts } from "@/lib/ats/resolve";
import { loadResolvedEmployers, recordSyncRun, runAtsIngestion } from "@/lib/sync/atsIngest";

const ALL_VENDORS: ResolvableAts[] = ["greenhouse", "lever", "ashby"];

function parseArgs(argv: string[]) {
  const vendorArg = argv.find((a) => a.startsWith("--vendors="));
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const vendors = vendorArg
    ? (vendorArg
        .split("=")[1]
        .split(",")
        .map((v) => v.trim())
        .filter((v): v is ResolvableAts => (ALL_VENDORS as string[]).includes(v)))
    : ALL_VENDORS;
  return {
    apply: argv.includes("--apply"),
    limit: limitArg ? parseInt(limitArg.split("=")[1], 10) : null,
    vendors: vendors.length > 0 ? vendors : ALL_VENDORS,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.apply ? "APPLY" : "DRY-RUN";
  console.log(`[ats:sync] mode=${mode} vendors=${args.vendors.join(",")}`);

  const employers = await loadResolvedEmployers(args.vendors);
  console.log(`[ats:sync] ${employers.length} employers with a resolved board\n`);

  if (employers.length === 0) {
    console.log("  No resolved boards. Run `npm run ats:resolve -- --apply` first.");
    process.exit(0);
  }

  const before = await prisma.job.count({ where: { activeFeed: true } });

  const metrics = await runAtsIngestion(employers, {
    limit: args.limit ?? undefined,
    dryRun: !args.apply,
    onProgress: (m) => console.log(m),
  });

  const after = await prisma.job.count({ where: { activeFeed: true } });

  console.log(`\n[ats:sync] ${mode} complete in ${(metrics.durationMs / 1000).toFixed(1)}s`);
  console.log(`  employers checked      : ${metrics.employersChecked}`);
  console.log(`  employers with postings: ${metrics.employersWithBoard}`);
  console.log(`  employers failed       : ${metrics.employersFailed}`);
  console.log(`  rows discovered        : ${metrics.rowsDiscovered}`);
  console.log(`  unique rows            : ${metrics.uniqueRows}`);
  console.log(`  duplicates prevented   : ${metrics.duplicatesPrevented}`);
  console.log(`  qualifying internships : ${metrics.qualifying}`);
  console.log(`  not an internship      : ${metrics.notInternship}`);
  console.log(`  uncertain (reviewable) : ${metrics.uncertain}`);
  console.log(`  confirmed closed       : ${metrics.closed}`);
  console.log(`  parse failures         : ${metrics.parseFailures}`);
  console.log(`  inserted               : ${metrics.inserted}`);
  console.log(`  updated                : ${metrics.updated}`);
  console.log(`  unchanged              : ${metrics.unchanged}`);
  console.log(`  persistence failures   : ${metrics.persistenceFailures}`);
  console.log(`  official URLs confirmed: ${metrics.officialUrlsConfirmed}`);
  console.log(`  active jobs before/after: ${before} -> ${after}`);

  console.log(`\n  by source:`);
  for (const [source, s] of Object.entries(metrics.bySource)) {
    console.log(
      `    ${source.padEnd(12)} discovered=${s.discovered} qualifying=${s.qualifying} inserted=${s.inserted} updated=${s.updated}`,
    );
  }

  const failures = Object.entries(metrics.failuresByReason).sort((a, b) => b[1] - a[1]);
  if (failures.length > 0) {
    console.log(`\n  rejected / skipped by reason:`);
    for (const [reason, count] of failures) console.log(`    ${reason.padEnd(32)} ${count}`);
  }

  if (args.apply) {
    const runId = await recordSyncRun(metrics, args.vendors, "success");
    console.log(`\n  AtsSyncRun recorded: ${runId}`);
  } else {
    console.log(`\n  Nothing was written. Re-run with --apply to persist.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[ats:sync] fatal", e);
    process.exit(1);
  });
