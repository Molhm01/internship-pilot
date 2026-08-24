// Live parity diagnostic for the fresh engineering radar.
//
//   npx tsx scripts/diagnose-fresh-radar.ts            # read-only comparison
//   npx tsx scripts/diagnose-fresh-radar.ts --resolve  # also run one full tick
//
// Read-only mode makes NO database writes and NO employer-board crawls. It
// fetches the public fresh signals, measures how many of them our catalogue
// already covers, and reports the stored unresolved-reason breakdown. That is
// enough to answer "are we keeping up with the source?" without starting the
// whole local stack.
//
// --resolve additionally runs one real radar tick and prints its diagnostics,
// which is the measurement that turns "resolution %" from an estimate into a
// number.

import "dotenv/config";
import { prisma } from "@/lib/db";
import { canonicalizeJobUrl } from "@/lib/sync/ingest";
import {
  fetchJobrightFreshSignals,
  formatFreshRadarDiagnostics,
  runJobrightFreshDiscovery,
  FRESH_SIGNAL_SOURCE,
} from "@/lib/sync/jobrightFreshDiscovery";
import {
  findApprovedCompany,
  loadApprovedCompanyIndex,
} from "@/lib/sync/employerBoardResolution";
import {
  formatReasonCounts,
  normalizeCompanyKey,
  type FreshSignalReason,
  type FreshSignalReasonCounts,
} from "@/lib/sync/freshSignalReasons";
import { isAggregatorUrl, isValidOfficialApplicationUrl } from "@/lib/applications/officialDestination";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function pct(part: number, whole: number): string {
  if (whole === 0) return "n/a";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function humanMs(ms: number | null): string {
  if (ms === null) return "n/a";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

async function main() {
  const resolve = process.argv.includes("--resolve");
  const now = new Date();

  console.log(`Fresh radar parity diagnostic — ${now.toISOString()}`);
  console.log("=".repeat(72));

  // ---- What the source is offering right now -------------------------------
  const source = await fetchJobrightFreshSignals(now);
  const signals = source.jobs;
  console.log("\nSOURCE");
  console.log(`  category rows        ${JSON.stringify(source.categoryCounts)}`);
  console.log(`  fresh opportunities  ${signals.length}`);
  console.log(`  <24h                 ${source.freshUnder24h} (${pct(source.freshUnder24h, signals.length)})`);
  console.log(`  <72h                 ${source.freshUnder72h} (${pct(source.freshUnder72h, signals.length)})`);

  const directUrls = signals.filter((signal) =>
    [signal.officialApplicationUrl, signal.originalJobPostUrl, signal.applyUrl].some(
      (value) => value && !isAggregatorUrl(value) && isValidOfficialApplicationUrl(value),
    ),
  ).length;
  console.log(`  with a direct official URL in the feed row: ${directUrls} (${pct(directUrls, signals.length)})`);

  // ---- Employer coverage ---------------------------------------------------
  const approvedIndex = await loadApprovedCompanyIndex();
  const companies = [...new Set(signals.map((signal) => signal.company))];
  const inApproved = companies.filter((name) => findApprovedCompany(name, approvedIndex) !== null);
  const cachedBoards = await prisma.employerBoardResolution.findMany({
    where: { normalizedCompany: { in: companies.map(normalizeCompanyKey) }, state: "RESOLVED" },
    select: { normalizedCompany: true },
  });
  const cachedKeys = new Set(cachedBoards.map((row) => row.normalizedCompany));
  const autoResolved = companies.filter(
    (name) => !findApprovedCompany(name, approvedIndex) && cachedKeys.has(normalizeCompanyKey(name)),
  );

  console.log("\nEMPLOYER COVERAGE");
  console.log(`  distinct employers in this sweep        ${companies.length}`);
  console.log(`  already in the approved-employer CSV    ${inApproved.length} (${pct(inApproved.length, companies.length)})`);
  console.log(`  auto-resolved to a board by the radar   ${autoResolved.length} (${pct(autoResolved.length, companies.length)})`);
  const uncovered = companies.length - inApproved.length - autoResolved.length;
  console.log(`  no board known yet                      ${uncovered} (${pct(uncovered, companies.length)})`);

  // ---- Stored resolution state --------------------------------------------
  const stored = await prisma.freshSignalResolution.groupBy({
    by: ["state"],
    where: { signalSource: FRESH_SIGNAL_SOURCE },
    _count: { _all: true },
  });
  const reasons = await prisma.freshSignalResolution.groupBy({
    by: ["reasonCode"],
    where: { signalSource: FRESH_SIGNAL_SOURCE, state: "PENDING" },
    _count: { _all: true },
  });
  const reasonCounts: FreshSignalReasonCounts = {};
  for (const row of reasons) {
    if (row.reasonCode) reasonCounts[row.reasonCode as FreshSignalReason] = row._count._all;
  }
  const totalTracked = stored.reduce((sum, row) => sum + row._count._all, 0);
  const resolvedTracked = stored.find((row) => row.state === "RESOLVED")?._count._all ?? 0;

  console.log("\nSTORED RESOLUTION STATE (all signals ever seen)");
  console.log(`  tracked signals   ${totalTracked}`);
  for (const row of stored.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`    ${row.state.padEnd(10)} ${row._count._all}`);
  }
  console.log(`  official resolution %  ${pct(resolvedTracked, totalTracked)}`);
  console.log(`  unresolved reasons     ${formatReasonCounts(reasonCounts)}`);

  // ---- Our catalogue -------------------------------------------------------
  const activeJobs = await prisma.job.findMany({
    where: { activeFeed: true, sourcePostedAt: { not: null } },
    select: { sourcePostedAt: true, firstSeenAt: true, officialApplicationUrl: true },
  });
  const under24h = activeJobs.filter(
    (job) => now.getTime() - job.sourcePostedAt!.getTime() <= ONE_DAY_MS,
  ).length;
  const under72h = activeJobs.filter(
    (job) => now.getTime() - job.sourcePostedAt!.getTime() <= 3 * ONE_DAY_MS,
  ).length;
  const discoveryDelays = activeJobs
    .filter((job) => job.firstSeenAt && now.getTime() - job.sourcePostedAt!.getTime() <= 7 * ONE_DAY_MS)
    .map((job) => job.firstSeenAt!.getTime() - job.sourcePostedAt!.getTime())
    .filter((delay) => delay >= 0);
  const canonicalUrls = new Set(
    activeJobs.map((job) => canonicalizeJobUrl(job.officialApplicationUrl)).filter(Boolean),
  );

  console.log("\nOUR DISCOVER FEED");
  console.log(`  active jobs with a known posting date   ${activeJobs.length}`);
  console.log(`  posted <24h                             ${under24h}`);
  console.log(`  posted <72h                             ${under72h}`);
  console.log(`  distinct canonical official URLs        ${canonicalUrls.size}`);
  console.log(`  duplicate active rows on one URL        ${activeJobs.length - canonicalUrls.size}`);
  console.log(`  median discovery delay (<7d postings)   ${humanMs(median(discoveryDelays))}`);

  const closed = await prisma.freshSignalResolution.count({
    where: { signalSource: FRESH_SIGNAL_SOURCE, state: "CLOSED" },
  });
  console.log(`  signals rejected as already closed      ${closed}`);

  // ---- Optional live tick --------------------------------------------------
  if (resolve) {
    console.log("\nRUNNING ONE FULL RADAR TICK (this crawls employer careers pages)…");
    const started = Date.now();
    const diagnostics = await runJobrightFreshDiscovery();
    console.log(`  finished in ${Math.round((Date.now() - started) / 1000)}s`);
    console.log(`  ${formatFreshRadarDiagnostics(diagnostics)}`);
    const attempted = diagnostics.examined;
    const resolvedNow =
      diagnostics.officialUrlDirect + diagnostics.sourceOriginalPost + diagnostics.boardResolved;
    console.log(`\n  RESOLUTION RATE THIS TICK: ${resolvedNow}/${attempted} = ${pct(resolvedNow, attempted)}`);
  } else {
    console.log("\n(read-only: pass --resolve to run a real resolution tick and measure the rate)");
  }
}

main()
  .catch((error) => {
    console.error("diagnose-fresh-radar failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
