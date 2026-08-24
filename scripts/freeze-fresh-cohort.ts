import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { fetchJobrightFreshSignals } from "@/lib/sync/jobrightFreshDiscovery";
import { isTargetEngineeringRole } from "@/lib/sync/classify";
import { FROZEN_COHORT_PATH, type FrozenCohort, type FrozenSignal } from "@/lib/sync/frozenCohort";

/**
 * Freeze today's radar population so a code change can be measured against it.
 *
 *   npx tsx scripts/freeze-fresh-cohort.ts [--limit=60] [--output=path]
 *
 * The live radar rotates. Two measurements taken hours apart are two different
 * denominators, and this project already spent a day comparing 56.7% against
 * 26.7% before noticing they were computed over different signals. A frozen
 * cohort makes "did the resolver get better" a question with an answer.
 *
 * What is frozen is the SIGNAL — the employer, title, location, source id and
 * timestamps the radar published. Nothing about the resolution is frozen: the
 * benchmark still crawls the employer's real board every run, because that is
 * the thing under test.
 *
 * This writes a fixture file. It never writes to the catalogue, and it never
 * invents a signal.
 */

async function main() {
  const limit = Number.parseInt(process.argv.find((v) => v.startsWith("--limit="))?.slice(8) ?? "60", 10) || 60;
  const outputPath = path.resolve(
    process.argv.find((v) => v.startsWith("--output="))?.slice(9) || FROZEN_COHORT_PATH,
  );

  const capturedAt = new Date();
  const source = await fetchJobrightFreshSignals(capturedAt);

  const signals: FrozenSignal[] = [];
  let irrelevant = 0;
  for (const [index, job] of source.jobs.entries()) {
    const valid = isTargetEngineeringRole(job.title, job.qualifications);
    if (!valid) irrelevant += 1;
    signals.push({
      source: "jobright",
      sourceJobId: job.sourceJobId,
      capturedAt: capturedAt.toISOString(),
      sourcePostedAt: job.sourcePostedAt?.toISOString() ?? null,
      sourcePostedText: job.sourcePostedText,
      sourceDateConfidence: job.sourceDateConfidence,
      sourceRowIndex: index,
      company: job.company,
      title: job.title,
      location: job.location,
      workModel: job.workModel,
      qualifications: job.qualifications,
      sourceUrl: job.applyUrl ?? null,
      classification: valid ? "valid" : "irrelevant",
    });
    if (signals.filter((s) => s.classification === "valid").length >= limit) break;
  }

  const cohort: FrozenCohort = {
    name: "fresh-discovery-frozen",
    capturedAt: capturedAt.toISOString(),
    radarSignalsFetched: source.jobs.length,
    freshUnder24h: source.freshUnder24h,
    freshUnder72h: source.freshUnder72h,
    signals,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(cohort, null, 2));

  const valid = signals.filter((s) => s.classification === "valid").length;
  console.log(`frozen cohort written  ${outputPath}`);
  console.log(`  captured at          ${cohort.capturedAt}`);
  console.log(`  radar signals        ${cohort.radarSignalsFetched}`);
  console.log(`  frozen signals       ${signals.length}`);
  console.log(`  valid engineering    ${valid}`);
  console.log(`  irrelevant           ${irrelevant}`);
  console.log(`  <24h / <72h          ${cohort.freshUnder24h} / ${cohort.freshUnder72h}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
