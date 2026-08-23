import "dotenv/config";
import { prisma } from "@/lib/db";
import { probeOfficialProvider, type OfficialProviderProbe } from "@/lib/ats/providerProbe";
import { upsertClassifiedAtsJob } from "@/lib/sync/ingest";
import {
  ATS_CONFIG_STATES,
  normalizedConfigState,
  percentile,
  reportProvider,
  type AtsConfigState,
} from "@/lib/sync/officialDiscoveryMetrics";
import { parseFirstSourceDate } from "@/lib/sync/sourceDate";
import { normalizeCompanyKey } from "@/lib/sync/freshSignalReasons";

const SUPPORTED = new Set(["workday", "successfactors", "icims", "greenhouse", "lever"]);
const DAY_MS = 86_400_000;

function argument(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function clampInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function compactEvidence(probe: OfficialProviderProbe): string {
  const evidence = { ...probe.evidence } as Record<string, unknown>;
  delete evidence.jobs;
  return JSON.stringify({
    access: probe.access,
    jobsScanned: probe.jobsScanned,
    totalAvailableJobs: probe.totalAvailableJobs,
    engineeringInternships: probe.engineeringJobs.length,
    paginationVerified: probe.paginationVerified,
    suggestedIdentifier: probe.suggestedIdentifier,
    ...evidence,
  }).slice(0, 8_000);
}

function trustedPostedAt(job: OfficialProviderProbe["jobs"][number], capturedAt: Date): Date | null {
  return parseFirstSourceDate([job.postedAt, job.postedAtText], capturedAt).sourcePostedAt;
}

function recentCounts(jobs: OfficialProviderProbe["engineeringJobs"], capturedAt: Date) {
  let under24h = 0;
  let under72h = 0;
  for (const job of jobs) {
    const postedAt = trustedPostedAt(job, capturedAt);
    if (!postedAt) continue;
    const age = capturedAt.getTime() - postedAt.getTime();
    if (age >= 0 && age <= DAY_MS) under24h += 1;
    if (age >= 0 && age <= 3 * DAY_MS) under72h += 1;
  }
  return { under24h, under72h };
}

async function ingest(probe: OfficialProviderProbe, companyId: string, capturedAt: Date): Promise<void> {
  if (probe.configState !== "VALIDATED") return;
  for (const [rowIndex, job] of probe.engineeringJobs.entries()) {
    await upsertClassifiedAtsJob({
      job,
      source: probe.provider,
      atsType: probe.provider,
      atsTenant: probe.suggestedIdentifier ?? probe.attemptedIdentifier ?? probe.provider,
      classification: "QUALIFYING_INTERNSHIP",
      classificationReason: "Read by the validated official-provider sweep and matched deterministic engineering internship rules.",
      capturedAt,
      syncRunId: `provider-sweep:${capturedAt.toISOString()}`,
      rowIndex,
      scheduleInitialMatch: false,
    });
  }
  await prisma.company.update({
    where: { id: companyId },
    data: { activeInternshipCount: probe.engineeringJobs.length },
  });
}

async function main() {
  const requested = (argument("providers") ?? argument("provider") ?? "workday,successfactors,icims,greenhouse,lever")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => SUPPORTED.has(value));
  if (requested.length === 0) throw new Error("No supported --providers were selected.");

  const offset = clampInteger(argument("offset"), 0, 0, 10_000);
  const limit = clampInteger(argument("limit"), 25, 1, 167);
  const concurrency = clampInteger(argument("concurrency"), 2, 1, 3);
  const persist = flag("persist");
  const repair = flag("repair");
  const repairedOnly = flag("repaired");
  const ingestJobs = flag("ingest");
  const started = new Date();
  const companyFilter = argument("company")?.trim().toLowerCase() ?? null;
  const stateFilter = new Set((argument("states") ?? "").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean));

  const [companies, historicalJobs] = await Promise.all([
    prisma.company.findMany({
      where: { allowlisted: true, atsType: { in: requested } },
      select: {
        id: true,
        name: true,
        atsType: true,
        atsIdentifier: true,
        careersUrl: true,
        atsConfigState: true,
        atsConfigEvidence: true,
        priority: true,
        csvEeCpeFit: true,
        activeInternshipCount: true,
        lastEngineeringInternshipAt: true,
      },
    }),
    prisma.job.findMany({
      where: {
        OR: [
          { classification: "QUALIFYING_INTERNSHIP" },
          { title: { contains: "intern", mode: "insensitive" } },
          { title: { contains: "co-op", mode: "insensitive" } },
        ],
      },
      select: { company: true, lastSeenAt: true, officialApplicationUrl: true, source: true, atsType: true },
    }),
  ]);

  const historical = new Map<string, Date | null>();
  const greenhouseEvidence = new Map<string, string[]>();
  const workdayEvidence = new Map<string, string[]>();
  for (const job of historicalJobs) {
    const key = normalizeCompanyKey(job.company);
    const previous = historical.get(key);
    if (!previous || (job.lastSeenAt && job.lastSeenAt > previous)) historical.set(key, job.lastSeenAt);
    if ((job.source === "greenhouse" || job.atsType === "greenhouse") && job.officialApplicationUrl) {
      const urls = greenhouseEvidence.get(key) ?? [];
      urls.push(job.officialApplicationUrl);
      greenhouseEvidence.set(key, urls);
    }
    if ((job.source === "workday" || job.atsType === "workday") && job.officialApplicationUrl) {
      const urls = workdayEvidence.get(key) ?? [];
      urls.push(job.officialApplicationUrl);
      workdayEvidence.set(key, urls);
    }
  }
  const tier = (company: typeof companies[number]): "A" | "B" | "C" => {
    if (company.lastEngineeringInternshipAt && started.getTime() - company.lastEngineeringInternshipAt.getTime() <= 30 * DAY_MS) return "A";
    return historical.has(normalizeCompanyKey(company.name)) ? "B" : "C";
  };
  const tierRank = { A: 0, B: 1, C: 2 } as const;
  const selected = companies
    .filter((company) => !companyFilter || company.name.toLowerCase() === companyFilter)
    .filter((company) => stateFilter.size === 0 || stateFilter.has(company.atsConfigState))
    .filter((company) => !repairedOnly || company.atsConfigEvidence?.includes('"repairedBy"'))
    .sort((left, right) => tierRank[tier(left)] - tierRank[tier(right)] || left.name.localeCompare(right.name))
    .slice(offset, offset + limit);

  console.log(`[provider-sweep] ${started.toISOString()} providers=${requested.join(",")} registry=${companies.length} selected=${selected.length} offset=${offset} concurrency=${concurrency} persist=${persist} ingest=${ingestJobs}`);
  const probes: Array<OfficialProviderProbe & { tier: "A" | "B" | "C" }> = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
    while (cursor < selected.length) {
      const company = selected[cursor++]!;
      const activityTier = tier(company);
      const capturedAt = new Date();
      const probe = await probeOfficialProvider(company, {
        discoverGreenhouse: repair,
        greenhouseEvidenceUrls: greenhouseEvidence.get(normalizeCompanyKey(company.name)) ?? [],
        discoverWorkday: repair,
        workdayEvidenceUrls: workdayEvidence.get(normalizeCompanyKey(company.name)) ?? [],
      });
      probes.push({ ...probe, tier: activityTier });
      const recent = recentCounts(probe.engineeringJobs, capturedAt);
      console.log(`${probe.configState.padEnd(9)} ${String(company.atsType).padEnd(14)} ${company.name} total=${probe.totalAvailableJobs} scanned=${probe.jobsScanned} eng=${probe.engineeringJobs.length} <24h=${recent.under24h} <72h=${recent.under72h} dates=${probe.engineeringQuality.exactTimestampJobs + probe.engineeringQuality.dateOnlyJobs + probe.engineeringQuality.relativeParsedJobs}/${probe.engineeringJobs.length} jd=${probe.engineeringQuality.fullJdJobs}/${probe.engineeringJobs.length} ${probe.errorCode ?? ""}`);
      if (flag("samples")) {
        console.log(`  config identifier=${company.atsIdentifier ?? "null"} careers=${company.careersUrl ?? "null"} suggested=${probe.suggestedIdentifier ?? "null"}`);
        for (const job of probe.engineeringJobs.slice(0, 3)) {
          console.log(`  sample ${job.title} | ${job.applyUrl} | date=${job.postedAt?.toISOString() ?? job.postedAtText ?? "unknown"} | jd=${job.description.length}`);
        }
      }

      if (persist) {
        const now = new Date();
        const nextTier = probe.engineeringJobs.length > 0 ? "A" : activityTier;
        await prisma.company.update({
          where: { id: company.id },
          data: {
            atsConfigState: probe.configState,
            atsConfigCheckedAt: now,
            ...(probe.configState === "VALIDATED" ? { atsValidatedAt: now } : {}),
            atsConfigErrorCode: probe.errorCode,
            atsConfigEvidence: compactEvidence(probe),
            engineeringActivityTier: nextTier,
            ...(probe.engineeringJobs.length > 0 ? { lastEngineeringInternshipAt: now } : {}),
            ...(repair && probe.suggestedIdentifier ? { atsIdentifier: probe.suggestedIdentifier } : {}),
          },
        });
        await prisma.officialBoardPoll.create({
          data: {
            companyId: company.id,
            companyName: company.name,
            provider: probe.provider,
            startedAt: new Date(capturedAt.getTime() - probe.durationMs),
            finishedAt: capturedAt,
            status: probe.configState === "VALIDATED" ? "success" : probe.configState === "UNSUPPORTED" ? "unsupported" : "error",
            jobsScanned: probe.jobsScanned,
            totalAvailableJobs: probe.totalAvailableJobs,
            engineeringInternshipsFound: probe.engineeringJobs.length,
            durationMs: probe.durationMs,
            errorCode: probe.errorCode,
            configState: probe.configState,
            paginationVerified: probe.paginationVerified,
            ...probe.engineeringQuality,
          },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  });
  await Promise.all(workers);

  // Keep database writes serial even when HTTP probes are concurrent. This
  // avoids sharing prepared-statement state across a burst of upserts and
  // keeps discovery ingestion independent from probe throughput.
  if (persist && ingestJobs) {
    const companyIdByName = new Map(companies.map((company) => [company.name, company.id]));
    for (const probe of probes) {
      const companyId = companyIdByName.get(probe.company);
      if (!companyId) continue;
      try {
        await ingest(probe, companyId, started);
      } catch (error) {
        console.error(`[provider-sweep] ingestion failed for ${probe.company}:`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  for (const provider of requested) {
    const rows = probes.filter((probe) => probe.provider === provider);
    const jobs = rows.flatMap((probe) => probe.engineeringJobs);
    const quality = rows.reduce((sum, probe) => ({
      exact: sum.exact + probe.engineeringQuality.exactTimestampJobs,
      dateOnly: sum.dateOnly + probe.engineeringQuality.dateOnlyJobs,
      relative: sum.relative + probe.engineeringQuality.relativeParsedJobs,
      unknown: sum.unknown + probe.engineeringQuality.unknownTimestampJobs,
      jd: sum.jd + probe.engineeringQuality.fullJdJobs,
    }), { exact: 0, dateOnly: 0, relative: 0, unknown: 0, jd: 0 });
    const recent = recentCounts(jobs, started);
    const durations = rows.map((row) => row.durationMs);
    const access = rows.reduce<Record<string, number>>((counts, row) => {
      counts[row.access] = (counts[row.access] ?? 0) + 1;
      return counts;
    }, {});
    console.log(JSON.stringify({
      provider,
      configured: companies.filter((company) => company.atsType === provider).length,
      attempted: rows.length,
      validated: rows.filter((row) => row.configState === "VALIDATED").length,
      stale: rows.filter((row) => row.configState === "STALE").length,
      malformed: rows.filter((row) => row.configState === "MALFORMED").length,
      untested: rows.filter((row) => row.configState === "UNTESTED").length,
      postingsAvailable: rows.reduce((sum, row) => sum + row.totalAvailableJobs, 0),
      postingsScanned: rows.reduce((sum, row) => sum + row.jobsScanned, 0),
      engineeringInternships: jobs.length,
      freshUnder24h: recent.under24h,
      freshUnder72h: recent.under72h,
      timestampCoveragePct: jobs.length ? Number((((jobs.length - quality.unknown) / jobs.length) * 100).toFixed(2)) : 0,
      jdHydrationPct: jobs.length ? Number(((quality.jd / jobs.length) * 100).toFixed(2)) : 0,
      timestampKinds: quality,
      medianQueryMs: percentile(durations, 0.5),
      access,
    }));
  }

  if (persist) {
    const registry = await prisma.company.findMany({
      where: { allowlisted: true },
      select: { atsType: true, atsIdentifier: true, careersUrl: true, atsConfigState: true },
    });
    const stateCounts = Object.fromEntries(ATS_CONFIG_STATES.map((state) => [state, 0])) as Record<AtsConfigState, number>;
    const byProvider: Record<string, Record<AtsConfigState, number>> = {};
    for (const company of registry) {
      const state = normalizedConfigState(company);
      const provider = reportProvider(company.atsType);
      stateCounts[state] += 1;
      byProvider[provider] ??= Object.fromEntries(ATS_CONFIG_STATES.map((entry) => [entry, 0])) as Record<AtsConfigState, number>;
      byProvider[provider][state] += 1;
    }
    console.log(JSON.stringify({ registry: registry.length, configurationStates: stateCounts, byProvider }));
  }
}

main()
  .catch((error) => {
    console.error("[provider-sweep] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
