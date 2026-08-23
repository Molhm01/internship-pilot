import "dotenv/config";
import { prisma } from "@/lib/db";
import { canonicalizeJobUrl } from "@/lib/sync/ingest";
import { normalizeCompanyKey } from "@/lib/sync/freshSignalReasons";
import {
  REPORT_PROVIDERS,
  ATS_CONFIG_STATES,
  classifyFreshRecall,
  gapGroup,
  isUsableProviderConfig,
  normalizedConfigState,
  percentile,
  reportProvider,
} from "@/lib/sync/officialDiscoveryMetrics";

const DIRECT_SOURCES = [
  "greenhouse", "lever", "ashby", "workday", "smartrecruiters", "successfactors",
  "eightfold", "phenom", "icims", "usajobs",
];
const DAY_MS = 86_400_000;

function percentage(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 100 : 0;
}

async function main() {
  const now = new Date();
  const [companies, learnedBoards, jobs, polls, signals] = await Promise.all([
    prisma.company.findMany({
      where: { allowlisted: true },
      select: {
        id: true, name: true, atsType: true, atsIdentifier: true, careersUrl: true,
        csvEeCpeFit: true, priority: true, lastCheckStatus: true, atsConfigState: true,
      },
    }),
    prisma.employerBoardResolution.findMany({
      select: { normalizedCompany: true, companyName: true, atsType: true, atsIdentifier: true, careersUrl: true, state: true },
    }),
    prisma.job.findMany({
      where: { OR: [{ source: { in: DIRECT_SOURCES } }, { atsType: { in: DIRECT_SOURCES } }] },
      select: {
        id: true, title: true, company: true, source: true, atsType: true, atsTenant: true,
        sourceJobId: true, requisitionId: true, officialApplicationUrl: true, sourcePostedAt: true,
        sourceDateProvenance: true, sourceDateConfidence: true, firstSeenAt: true,
        officialFirstSeenAt: true, discoveryPipeline: true, description: true, activeFeed: true,
        verificationStatus: true, closedAt: true, classification: true, disciplineTags: true,
      },
    }),
    prisma.officialBoardPoll.findMany({ orderBy: { startedAt: "desc" }, take: 10_000 }),
    prisma.freshSignalResolution.findMany({
      where: { sourceCapturedAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } },
      select: { state: true, workflowState: true, resolutionPath: true, reasonCode: true, sourcePostedAt: true },
    }),
  ]);

  const registry = new Map(companies.map((company) => [normalizeCompanyKey(company.name), {
    name: company.name,
    atsType: company.atsType,
    atsIdentifier: company.atsIdentifier,
    careersUrl: company.careersUrl,
    atsConfigState: company.atsConfigState,
    origin: "catalog" as const,
  }]));
  let dynamicOnly = 0;
  for (const board of learnedBoards) {
    if (registry.has(board.normalizedCompany)) continue;
    dynamicOnly += 1;
    registry.set(board.normalizedCompany, {
      name: board.companyName,
      atsType: board.state === "RESOLVED" ? board.atsType : null,
      atsIdentifier: board.state === "RESOLVED" ? board.atsIdentifier : null,
      careersUrl: board.careersUrl,
      atsConfigState: "UNTESTED",
      origin: "catalog" as const,
    });
  }

  const providerDistribution = Object.fromEntries(REPORT_PROVIDERS.map((provider) => [provider, 0]));
  let providerKnown = 0;
  let providerUnknown = 0;
  let usableProviderConfigurations = 0;
  const configurationStates = Object.fromEntries(ATS_CONFIG_STATES.map((state) => [state, 0])) as Record<string, number>;
  const providerConfigurationStates = Object.fromEntries(REPORT_PROVIDERS.map((provider) => [
    provider,
    Object.fromEntries(ATS_CONFIG_STATES.map((state) => [state, 0])) as Record<string, number>,
  ]));
  for (const employer of registry.values()) {
    const provider = reportProvider(employer.atsType);
    const configState = normalizedConfigState(employer);
    providerDistribution[provider] += 1;
    configurationStates[configState] += 1;
    providerConfigurationStates[provider][configState] += 1;
    if (provider === "Unknown") providerUnknown += 1;
    else providerKnown += 1;
    if (isUsableProviderConfig(employer)) usableProviderConfigurations += 1;
  }

  const highValueMissing = companies
    .filter((company) => company.csvEeCpeFit === "High" && !isUsableProviderConfig(company))
    .sort((a, b) => (a.priority === "priority" ? -1 : 0) - (b.priority === "priority" ? -1 : 0) || a.name.localeCompare(b.name))
    .map((company) => ({ name: company.name, careersUrl: company.careersUrl, currentProvider: company.atsType ?? "unknown" }));

  const activeOfficial = jobs.filter((job) => {
    if (!job.activeFeed || job.verificationStatus !== "VERIFIED_OFFICIAL_AT_LAST_CHECK") return false;
    if (job.classification === "QUALIFYING_INTERNSHIP") return true;
    if (!/\b(intern(ship)?s?|co-?ops?|student trainee)\b/i.test(job.title)) return false;
    try {
      return Array.isArray(JSON.parse(job.disciplineTags ?? "[]")) && JSON.parse(job.disciplineTags ?? "[]").length > 0;
    } catch {
      return false;
    }
  });
  const fresh24h = activeOfficial.filter((job) => job.sourcePostedAt && now.getTime() - job.sourcePostedAt.getTime() <= DAY_MS).length;
  const fresh72h = activeOfficial.filter((job) => job.sourcePostedAt && now.getTime() - job.sourcePostedAt.getTime() <= 3 * DAY_MS).length;
  const withJd = activeOfficial.filter((job) => job.description.trim().length > 200).length;
  const unknownDates = activeOfficial.filter((job) => !job.sourcePostedAt).length;
  const delays = activeOfficial
    .filter((job) => job.sourcePostedAt && job.firstSeenAt)
    .map((job) => job.firstSeenAt!.getTime() - job.sourcePostedAt!.getTime())
    .filter((delay) => delay >= 0);
  const newPipelineDelays = activeOfficial
    .filter((job) =>
      job.discoveryPipeline === "official-first-v2"
      && job.officialFirstSeenAt
      && job.sourcePostedAt
      && ["EMPLOYER_ATS_EXACT", "EMPLOYER_ATS_DATE"].includes(job.sourceDateProvenance ?? "")
      && ["EXACT", "DATE_ONLY"].includes(job.sourceDateConfidence ?? ""))
    .map((job) => job.officialFirstSeenAt!.getTime() - job.sourcePostedAt!.getTime())
    .filter((delay) => delay >= 0);
  const newPipelineJobs = activeOfficial.filter((job) => job.discoveryPipeline === "official-first-v2");
  const newPipelineKnownDates = newPipelineJobs.filter((job) => job.sourcePostedAt).length;
  const newPipelineJds = newPipelineJobs.filter((job) => job.description.trim().length > 200).length;

  const duplicateKeys = new Map<string, number>();
  for (const job of activeOfficial) {
    const company = normalizeCompanyKey(job.company);
    const key = job.requisitionId
      ? `${company}|req|${job.requisitionId.toLowerCase()}`
      : `${company}|url|${canonicalizeJobUrl(job.officialApplicationUrl) ?? job.id}`;
    duplicateKeys.set(key, (duplicateKeys.get(key) ?? 0) + 1);
  }
  const duplicateRows = [...duplicateKeys.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const closedJobs = jobs.filter((job) => job.closedAt || job.verificationStatus === "Closed").length;

  const recallCounts = {
    ALREADY_FOUND_OFFICIALLY: 0,
    RESOLVED_AFTER_PRIORITY_TRIGGER: 0,
    OFFICIAL_JOB_EXISTS_BUT_MATCH_FAILED: 0,
    SOURCE_SIGNAL_STALE: 0,
    SOURCE_SIGNAL_IRRELEVANT: 0,
    UNRESOLVED: 0,
  };
  const gaps: Record<string, number> = {};
  for (const signal of signals) {
    const classification = classifyFreshRecall(signal);
    recallCounts[classification] += 1;
    if (classification === "UNRESOLVED" || classification === "OFFICIAL_JOB_EXISTS_BUT_MATCH_FAILED") {
      const group = gapGroup(signal.reasonCode);
      gaps[group] = (gaps[group] ?? 0) + 1;
    }
  }
  const validSignals = signals.length - recallCounts.SOURCE_SIGNAL_STALE - recallCounts.SOURCE_SIGNAL_IRRELEVANT;
  const officialMatches = recallCounts.ALREADY_FOUND_OFFICIALLY + recallCounts.RESOLVED_AFTER_PRIORITY_TRIGGER;

  const latestPollByCompany = new Map<string, (typeof polls)[number]>();
  for (const poll of polls) {
    const key = poll.companyId ?? normalizeCompanyKey(poll.companyName);
    if (!latestPollByCompany.has(key)) latestPollByCompany.set(key, poll);
  }
  const latestPolls = [...latestPollByCompany.values()];
  const providerCoverage = REPORT_PROVIDERS.map((provider) => {
    const configured = [...registry.values()].filter(
      (employer) => reportProvider(employer.atsType) === provider && isUsableProviderConfig(employer),
    ).length;
    const providerPolls = latestPolls.filter((poll) => reportProvider(poll.provider) === provider);
    const providerJobs = activeOfficial.filter((job) => reportProvider(job.atsType ?? job.source) === provider);
    const currentEngineering = providerPolls.reduce((sum, poll) => sum + poll.engineeringInternshipsFound, 0);
    const providerKnownDates = providerPolls.reduce((sum, poll) => sum
      + poll.exactTimestampJobs + poll.dateOnlyJobs + poll.relativeParsedJobs + poll.radarFallbackJobs, 0);
    const providerJds = providerPolls.reduce((sum, poll) => sum + poll.fullJdJobs, 0);
    return {
      provider,
      employersConfigured: configured,
      employersSuccessfullyQueried: providerPolls.filter((poll) => poll.status === "success" || poll.status === "not_modified").length,
      currentJobsScanned: providerPolls.reduce((sum, poll) => sum + poll.jobsScanned, 0),
      engineeringInternshipsFound: currentEngineering,
      freshUnder24h: providerJobs.filter((job) => job.sourcePostedAt && now.getTime() - job.sourcePostedAt.getTime() <= DAY_MS).length,
      freshUnder72h: providerJobs.filter((job) => job.sourcePostedAt && now.getTime() - job.sourcePostedAt.getTime() <= 3 * DAY_MS).length,
      errors: providerPolls.filter((poll) => poll.status === "error").length,
      medianQueryMs: percentile(providerPolls.map((poll) => poll.durationMs), 0.5),
      timestampCoveragePercent: percentage(providerKnownDates, currentEngineering),
      jdHydrationPercent: percentage(providerJds, currentEngineering),
    };
  });

  const report = {
    generatedAt: now.toISOString(),
    registry: {
      catalogEmployers: companies.length,
      dynamicallyLearnedEmployers: dynamicOnly,
      totalUniqueEmployers: registry.size,
      providerKnown,
      providerUnknown,
      usableProviderConfigurations,
      missingUsableProviderConfigurations: registry.size - usableProviderConfigurations,
      providerDistribution,
      configurationStates,
      providerConfigurationStates,
      highValueMissingUsableConfiguration: highValueMissing,
    },
    officialCatalog: {
      boardsSuccessfullyQueried: latestPolls.filter((poll) => poll.status === "success" || poll.status === "not_modified").length,
      engineeringInternshipsFound: activeOfficial.length,
      freshUnder24h: fresh24h,
      freshUnder72h: fresh72h,
      medianDiscoveryDelayMs: percentile(delays, 0.5),
      p90DiscoveryDelayMs: percentile(delays, 0.9),
      historicalMedianDiscoveryDelayMs: percentile(delays, 0.5),
      historicalP90DiscoveryDelayMs: percentile(delays, 0.9),
      newPipelineTrustedRows: newPipelineDelays.length,
      newPipelineMedianDiscoveryDelayMs: percentile(newPipelineDelays, 0.5),
      newPipelineP90DiscoveryDelayMs: percentile(newPipelineDelays, 0.9),
      newPipelineUnknownDateRatePercent: percentage(newPipelineJobs.length - newPipelineKnownDates, newPipelineJobs.length),
      newPipelineJdHydrationPercent: percentage(newPipelineJds, newPipelineJobs.length),
      jdHydrationPercent: percentage(withJd, activeOfficial.length),
      duplicateRatePercent: percentage(duplicateRows, activeOfficial.length),
      closedJobRatePercent: percentage(closedJobs, jobs.length),
      unknownDateRatePercent: percentage(unknownDates, activeOfficial.length),
    },
    freshRecall: {
      signals: signals.length,
      validSignals,
      ...recallCounts,
      officialCatalogMatches: officialMatches,
      trueRecallPercent: percentage(officialMatches, validSignals),
      unresolvedBreakdown: gaps,
    },
    providerCoverage,
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`[official-discovery] ${report.generatedAt}`);
  console.log(`registry ${report.registry.catalogEmployers} catalog + ${dynamicOnly} learned = ${registry.size} unique; VALIDATED usable=${usableProviderConfigurations}; states=${JSON.stringify(configurationStates)}`);
  console.log(`providers ${Object.entries(providerDistribution).map(([key, value]) => `${key}=${value}`).join(" ")}`);
  console.log(`official boards successful=${report.officialCatalog.boardsSuccessfullyQueried} engineering internships=${activeOfficial.length} <24h=${fresh24h} <72h=${fresh72h}`);
  console.log(`fresh signals valid=${validSignals} alreadyOfficial=${recallCounts.ALREADY_FOUND_OFFICIALLY} resolvedAfterTrigger=${recallCounts.RESOLVED_AFTER_PRIORITY_TRIGGER} recall=${report.freshRecall.trueRecallPercent}%`);
  console.log(`delay median=${report.officialCatalog.medianDiscoveryDelayMs ?? "n/a"}ms p90=${report.officialCatalog.p90DiscoveryDelayMs ?? "n/a"}ms JD=${report.officialCatalog.jdHydrationPercent}% duplicates=${report.officialCatalog.duplicateRatePercent}% unknownDates=${report.officialCatalog.unknownDateRatePercent}%`);
  console.log(`new-pipeline trusted=${newPipelineDelays.length} median=${report.officialCatalog.newPipelineMedianDiscoveryDelayMs ?? "n/a"}ms p90=${report.officialCatalog.newPipelineP90DiscoveryDelayMs ?? "n/a"}ms`);
  console.log(`new-pipeline quality rows=${newPipelineJobs.length} unknownDates=${report.officialCatalog.newPipelineUnknownDateRatePercent}% JD=${report.officialCatalog.newPipelineJdHydrationPercent}%`);
  console.table(providerCoverage);
  console.log(`high-value employers missing usable config (${highValueMissing.length}): ${highValueMissing.slice(0, 30).map((item) => item.name).join(", ") || "none"}`);
  console.log(`unresolved gaps ${JSON.stringify(gaps)}`);
}

main()
  .catch((error) => {
    console.error("[official-discovery] failed", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
