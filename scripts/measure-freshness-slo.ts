import "dotenv/config";
import { prisma } from "@/lib/db";

/**
 * Steady-state discovery-latency SLO.
 *
 *   npx tsx scripts/measure-freshness-slo.ts [--since=ISO] [--min-sample=N]
 *
 * How long, in production, between an employer publishing a requisition and
 * Internship Pilot seeing it on the employer's own board.
 *
 * Two things make this number easy to fake, so both are excluded by
 * construction rather than by judgment:
 *
 *   1. Backlog imports. The first run of the official-first crawler discovered
 *      thousands of postings that were weeks old; their "delay" is the age of
 *      the backlog, not the latency of the pipeline. Only jobs whose
 *      officialFirstSeenAt falls after a stated cutover instant are counted.
 *
 *   2. Guessed posting dates. A relative string ("30+ days ago") or an
 *      inferred date produces a delay that measures the guess. Only postings
 *      whose timestamp came from the employer's own ATS or structured data,
 *      at exact precision, are counted.
 *
 * When too few rows survive both filters the answer is INSUFFICIENT_SAMPLE.
 * There is no version of this script that reports compliance from a sample it
 * does not have.
 */

const OFFICIAL_PIPELINE = "official-first-v2";

/** Timestamps the employer itself published, at instant precision. */
const TRUSTWORTHY_PROVENANCE = ["EMPLOYER_ATS_EXACT", "EMPLOYER_JSON_LD"];
const TRUSTWORTHY_CONFIDENCE = ["EXACT"];

const MINUTE_MS = 60_000;

function arg(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

function formatMinutes(ms: number | null): string {
  if (ms === null) return "n/a";
  const minutes = ms / MINUTE_MS;
  if (minutes < 90) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

async function main() {
  const minSample = Number.parseInt(arg("min-sample") ?? "20", 10) || 20;

  // The cutover: the instant the official-first pipeline began writing
  // officialFirstSeenAt on this deployment. Everything before it is backlog.
  const explicitSince = arg("since");
  let since: Date;
  if (explicitSince) {
    since = new Date(explicitSince);
    if (Number.isNaN(since.getTime())) {
      console.error(`--since=${explicitSince} is not a valid date.`);
      process.exitCode = 1;
      return;
    }
  } else {
    // Default: exclude the first calendar day of official-first discovery,
    // which is by definition the import of everything already posted.
    const earliest = await prisma.job.findFirst({
      where: { discoveryPipeline: OFFICIAL_PIPELINE, officialFirstSeenAt: { not: null } },
      orderBy: { officialFirstSeenAt: "asc" },
      select: { officialFirstSeenAt: true },
    });
    if (!earliest?.officialFirstSeenAt) {
      console.log("STEADY-STATE FRESHNESS SLO: INSUFFICIENT_SAMPLE");
      console.log("No job has been discovered by the official-first pipeline yet.");
      return;
    }
    since = new Date(earliest.officialFirstSeenAt.getTime() + 24 * 60 * MINUTE_MS);
  }

  const cohort = await prisma.job.findMany({
    where: {
      discoveryPipeline: OFFICIAL_PIPELINE,
      officialFirstSeenAt: { gte: since },
      sourcePostedAt: { not: null },
      sourceDateConfidence: { in: TRUSTWORTHY_CONFIDENCE },
      sourceDateProvenance: { in: TRUSTWORTHY_PROVENANCE },
    },
    select: {
      id: true,
      title: true,
      company: true,
      atsType: true,
      sourcePostedAt: true,
      officialFirstSeenAt: true,
      sourceDateProvenance: true,
    },
  });

  const delays: number[] = [];
  let negative = 0;
  for (const job of cohort) {
    const delay = job.officialFirstSeenAt!.getTime() - job.sourcePostedAt!.getTime();
    // A negative delay means the two clocks disagree, not that discovery
    // preceded posting. Reported, never silently folded into the median.
    if (delay < 0) {
      negative += 1;
      continue;
    }
    delays.push(delay);
  }

  const total = await prisma.job.count({ where: { discoveryPipeline: OFFICIAL_PIPELINE } });
  const afterCutover = await prisma.job.count({
    where: { discoveryPipeline: OFFICIAL_PIPELINE, officialFirstSeenAt: { gte: since } },
  });

  console.log("Steady-state discovery-latency SLO");
  console.log("=".repeat(60));
  console.log(`cutover (backlog excluded before)   ${since.toISOString()}`);
  console.log(`official-first jobs, all time       ${total}`);
  console.log(`official-first jobs after cutover   ${afterCutover}`);
  console.log(`  with a trustworthy employer date  ${cohort.length}`);
  console.log(`  usable (non-negative delay)       ${delays.length}`);
  if (negative > 0) console.log(`  excluded, clock disagreement      ${negative}`);

  if (delays.length < minSample) {
    console.log("");
    console.log("STEADY-STATE FRESHNESS SLO: INSUFFICIENT_SAMPLE");
    console.log(
      `${delays.length} usable measurement(s); at least ${minSample} are needed before a p50/p90 means anything.`,
    );
    console.log("No compliance claim is made from this sample.");
    return;
  }

  const sorted = [...delays].sort((left, right) => left - right);
  const p50 = percentile(sorted, 0.5);
  const p90 = percentile(sorted, 0.9);
  const within = (ms: number) => sorted.filter((delay) => delay <= ms).length / sorted.length;

  console.log("");
  console.log(`count               ${sorted.length}`);
  console.log(`p50 discovery delay ${formatMinutes(p50)}`);
  console.log(`p90 discovery delay ${formatMinutes(p90)}`);
  console.log(`< 15m               ${(within(15 * MINUTE_MS) * 100).toFixed(1)}%`);
  console.log(`< 30m               ${(within(30 * MINUTE_MS) * 100).toFixed(1)}%`);
  console.log(`< 60m               ${(within(60 * MINUTE_MS) * 100).toFixed(1)}%`);
  console.log("");
  console.log(`target              p50 < 15m, p90 < 60m`);
  const meetsTarget = p50 !== null && p90 !== null && p50 < 15 * MINUTE_MS && p90 < 60 * MINUTE_MS;
  console.log(`STEADY-STATE FRESHNESS SLO: ${meetsTarget ? "MEETS TARGET" : "BELOW TARGET"}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
