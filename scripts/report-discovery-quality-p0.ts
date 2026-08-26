import "dotenv/config";
import { pinCanonicalDatabaseUrl, announceCanonicalDatabase } from "./lib/canonicalDb";

const canonical = pinCanonicalDatabaseUrl();

import { prisma } from "@/lib/db";
import { discoverFreshnessGroup } from "@/lib/jobs/freshness";
import { dateQuality, destinationQuality, jobDescriptionQuality } from "@/lib/jobs/jobQuality";
import {
  calculateFreshLatency,
  calculateRecall,
  classifyIcimsAccess,
  isSupportedReachable,
  rankMissingProviders,
} from "@/lib/sync/providerQuality";
import { DISCOVERY_QUALITY_COHORT_KEY } from "@/lib/sync/schedulerState";
import { normalizeCompanyKey } from "@/lib/sync/freshSignalReasons";

const PROVIDERS = ["Workday", "SuccessFactors", "Greenhouse", "Lever", "Ashby", "iCIMS", "SmartRecruiters", "Custom/API", "Other"] as const;

function provider(source: string | null, atsType: string | null): typeof PROVIDERS[number] {
  const value = (atsType ?? source ?? "").toLowerCase();
  if (value === "workday") return "Workday";
  if (value === "successfactors") return "SuccessFactors";
  if (value === "greenhouse") return "Greenhouse";
  if (value === "lever") return "Lever";
  if (value === "ashby") return "Ashby";
  if (value === "icims") return "iCIMS";
  if (value === "smartrecruiters") return "SmartRecruiters";
  if (["custom", "api", "eightfold", "phenom", "taleo"].includes(value)) return "Custom/API";
  return "Other";
}

function percent(part: number, total: number): number { return total ? Math.round(part / total * 10_000) / 100 : 0; }

function missingClassification(company: { atsType: string | null; atsIdentifier: string | null; careersUrl: string | null; atsConfigErrorCode: string | null; atsConfigEvidence: string | null }) {
  const type = company.atsType?.toLowerCase() ?? "unknown";
  if (/BOT_WALL/i.test(company.atsConfigErrorCode ?? "") || /bot.wall|captcha/i.test(company.atsConfigEvidence ?? "")) return "BOT_WALL";
  if (["greenhouse", "lever", "ashby", "workday", "successfactors", "smartrecruiters", "eightfold", "phenom", "icims"].includes(type) && company.atsIdentifier) return "SUPPORTED_EXISTING_PROVIDER";
  if (["eightfold", "phenom", "taleo", "avature", "beamery", "paradox"].includes(type)) return "REUSABLE_NEW_PROVIDER_PATTERN";
  if (!company.careersUrl) return "INVALID/STALE";
  if (type === "custom" || type === "unknown") return "CUSTOM_PAGE_ONLY";
  return "REUSABLE_NEW_PROVIDER_PATTERN";
}

async function main() {
  announceCanonicalDatabase(await prisma.job.count(), canonical);
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  // Sequential, not Promise.all: four concurrent queries sharing one pooled
  // connection have been observed to trip "Server has closed the connection"
  // against a local Prisma Dev instance under connection pressure (stale
  // connections left behind by a killed process, another instance also
  // running, etc.). This is a diagnostic script, not a hot path — reliability
  // here matters far more than shaving the few hundred ms four awaits cost.
  const jobs = await prisma.job.findMany({ where: { activeFeed: true }, select: {
    id: true, source: true, atsType: true, description: true, jobResponsibilities: true, jobQualifications: true,
    sourcePostedAt: true, sourceDateConfidence: true, firstSeenAt: true,
    officialApplicationUrl: true, officialJobUrl: true, sourceListingUrl: true, resolutionStatus: true, verificationStatus: true,
  } });
  const companies = await prisma.company.findMany({ where: { allowlisted: true }, select: {
    name: true, careersUrl: true, atsType: true, atsIdentifier: true, atsConfigState: true, atsConfigErrorCode: true,
    atsConfigEvidence: true, priority: true, engineeringActivityTier: true, activeInternshipCount: true,
    lastSuccessfulBoardAt: true,
  } });
  const signals = await prisma.freshSignalResolution.findMany({ where: { sourcePostedAt: { gte: sevenDaysAgo } }, select: {
    company: true, normalizedCompany: true, state: true, reasonCode: true, resolvedJobId: true,
    sourceCapturedAt: true, lastAttemptAt: true,
  } });
  const cohortSetting = await prisma.appSetting.findUnique({ where: { key: DISCOVERY_QUALITY_COHORT_KEY } });
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const quality = jobs.map((job) => ({ job, date: dateQuality(job), jd: jobDescriptionQuality(job), destination: destinationQuality(job) }));
  const freshKnown = jobs.filter((job) => discoverFreshnessGroup(job, now).startsWith("KNOWN_")).length;
  const freshUnknown = jobs.filter((job) => discoverFreshnessGroup(job, now).startsWith("UNKNOWN_")).length;

  // Fresh JD quality, separate from the full historical backlog: what
  // matters for returning to Autofill Phase 2B is whether jobs a user
  // actually SEES right now have a usable JD, not whether a 6-week-old row
  // does.
  const freshQuality = (group: "KNOWN_" | "UNKNOWN_") => quality.filter((row) => discoverFreshnessGroup(row.job, now).startsWith(group));
  const freshJdSummary = (rows: typeof quality) => {
    const usableOrFull = rows.filter((row) => row.jd === "FULL" || row.jd === "USABLE").length;
    return {
      total: rows.length,
      full: rows.filter((row) => row.jd === "FULL").length,
      usable: rows.filter((row) => row.jd === "USABLE").length,
      thin: rows.filter((row) => row.jd === "THIN").length,
      missing: rows.filter((row) => row.jd === "MISSING").length,
      usableOrFull,
      usableOrFullPercent: percent(usableOrFull, rows.length),
    };
  };
  const freshKnownRows = freshQuality("KNOWN_");
  const freshUnknownRows = freshQuality("UNKNOWN_");
  const freshCombinedRows = [...freshKnownRows, ...freshUnknownRows];
  const freshJdQuality = {
    knownDate: freshJdSummary(freshKnownRows),
    newlyDiscoveredUnknownDate: freshJdSummary(freshUnknownRows),
    combined: freshJdSummary(freshCombinedRows),
  };

  const providerQuality = Object.fromEntries(PROVIDERS.map((name) => {
    const rows = quality.filter((row) => provider(row.job.source, row.job.atsType) === name);
    const known = rows.filter((row) => row.date !== "UNKNOWN").length;
    const jd = rows.filter((row) => row.jd === "FULL" || row.jd === "USABLE").length;
    return [name, { active: rows.length, knownDate: known, knownDatePercent: percent(known, rows.length), usableJd: jd, usableJdPercent: percent(jd, rows.length) }];
  }));

  const signalCounts = new Map<string, number>();
  for (const signal of signals.filter((row) => row.state !== "RESOLVED")) signalCounts.set(signal.normalizedCompany, (signalCounts.get(signal.normalizedCompany) ?? 0) + 1);
  const missing = companies.filter((company) => company.atsConfigState !== "VALIDATED");
  const ranked = rankMissingProviders(missing.map((company) => ({
    name: company.name,
    engineeringActivityTier: company.engineeringActivityTier,
    priority: company.priority,
    activeInternshipCount: company.activeInternshipCount,
    recentUnresolvedSignals: signalCounts.get(normalizeCompanyKey(company.name)) ?? 0,
    atsType: company.atsType,
  }))).slice(0, 25).map((row) => {
    const company = missing.find((item) => item.name === row.name)!;
    return { ...row, atsConfigState: company.atsConfigState, classification: missingClassification(company) };
  });

  const recall = calculateRecall(signals.map((signal) => ({
    canonical: Boolean(signal.resolvedJobId),
    supportedReachable: isSupportedReachable(signal),
  })));
  const cohortStartedAt = cohortSetting ? new Date(JSON.parse(cohortSetting.value) as string) : now;
  const latency = calculateFreshLatency(signals.map((signal) => ({
    sourceCapturedAt: signal.sourceCapturedAt,
    officialResolutionStartedAt: signal.lastAttemptAt,
    canonicalStoredAt: signal.resolvedJobId ? jobsById.get(signal.resolvedJobId)?.firstSeenAt ?? null : null,
    supportedReachable: isSupportedReachable(signal),
  })), cohortStartedAt);

  const icims = companies.filter((company) => company.atsType === "icims").map((company) => classifyIcimsAccess({
    configState: company.atsConfigState,
    errorCode: company.atsConfigErrorCode,
    evidence: company.atsConfigEvidence,
    hasIdentifier: Boolean(company.atsIdentifier),
    lastSuccessfulBoardAt: company.lastSuccessfulBoardAt,
    activeInternshipCount: company.activeInternshipCount,
  }));
  const icimsCounts = Object.fromEntries([...new Set(icims)].map((state) => [state, icims.filter((item) => item === state).length]));
  const dateCounts = Object.fromEntries(["EXACT_TIMESTAMP", "DATE_ONLY", "UNKNOWN"].map((state) => [state, quality.filter((row) => row.date === state).length]));
  const jdCounts = Object.fromEntries(["FULL", "USABLE", "THIN", "MISSING"].map((state) => [state, quality.filter((row) => row.jd === state).length]));

  console.log(JSON.stringify({
    measuredAt: now.toISOString(), active: jobs.length,
    dateQuality: { ...dateCounts, unknownRate: percent(dateCounts.UNKNOWN ?? 0, jobs.length) },
    fresh: { knownRecent: freshKnown, newlyDiscoveredUnknownDate: freshUnknown, total: freshKnown + freshUnknown },
    freshJdQuality,
    jdQuality: { ...jdCounts, usableOrFull: (jdCounts.FULL ?? 0) + (jdCounts.USABLE ?? 0), usableOrFullPercent: percent((jdCounts.FULL ?? 0) + (jdCounts.USABLE ?? 0), jobs.length) },
    providerQuality, icims: icimsCounts, topMissingProviders: ranked, recall,
    steadyStateLatency: { cohortStartedAt: cohortStartedAt.toISOString(), ...latency },
  }, null, 2));
}

main().catch((error) => { console.error("[report-discovery-quality-p0] failed", error); process.exitCode = 1; }).finally(() => void prisma.$disconnect());
