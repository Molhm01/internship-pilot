// Dry-run measurement of the fresh radar's official-resolution rate.
//
//   npx tsx scripts/measure-fresh-resolution.ts [sampleSize]
//
// This runs the REAL resolution pipeline — detail enrichment, employer domain,
// careers-page crawl, client-rendered vendor detection, ATS board read,
// title/location match, availability probe, JD fetch — against live public
// signals. It reads the canonical catalog from PostgreSQL, never mutates it,
// and persists the classified signal sample as a disposable JSON benchmark.
// Only PostgreSQL is needed; the web app and workers stay stopped.

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { listJobsForCompany } from "@/lib/ats";
import type { AtsJob } from "@/lib/ats/types";
import {
  detectAtsForCareersPage,
  detectAtsFromText,
  detectClientRenderedAts,
} from "@/lib/ats/detect";
import { resolveAtsForCompany } from "@/lib/ats/resolve";
import { fetchEightfoldJobDescription } from "@/lib/ats/eightfold";
import { fetchPhenomJobDescription } from "@/lib/ats/phenom";
import { discoverFromRenderedShell } from "@/lib/ats/spaDiscovery";
import { renderCareersPage, resolveWithHeadlessBrowser } from "@/lib/ats/headlessResolver";
import { listEmployerPageJobs } from "@/lib/ats/employerPageLinks";
import { careersLinksFromHomepage, hostCandidates } from "@/lib/sync/employerBoardResolution";
import {
  extractNextData,
  parseInternListPayload,
  type RawInternListJob,
} from "@/lib/sync/internListAdapter";
import { isTargetEngineeringRole } from "@/lib/sync/classify";
import { classifyOfficialBoardMatch } from "@/lib/sync/officialBoardMatch";
import { probeOfficialJobAvailability } from "@/lib/sync/freshness";
import { fetchJobrightSignalDetail } from "@/lib/sync/jobrightSignalDetail";
import {
  countReason,
  emptyReasonCounts,
  formatReasonCounts,
  normalizeCompanyKey,
  type FreshSignalReason,
} from "@/lib/sync/freshSignalReasons";
import { boardCacheKey } from "@/lib/sync/jobrightFreshDiscovery";
import { inferResolvedSource } from "@/lib/sync/discoveryResolution";
import {
  isAggregatorUrl,
  isValidOfficialApplicationUrl,
} from "@/lib/applications/officialDestination";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SLUGS = ["engineering_development", "data_engineer", "data_science"];
const CAREERS_PATHS = ["/careers", "/careers/jobs", "/jobs", "/company/careers", "/"];
const READABLE = [
  "spa",
  "employer-page",
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workday",
  "icims",
  "taleo",
  "eightfold",
  "phenom",
];
const BOT_WALLED = new Set(["icims", "taleo", "custom", "spa", "employer-page"]);
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ALLOW_HEADLESS = process.argv.includes("--headless");
let headlessBudget = ALLOW_HEADLESS ? 2 : 0;

type FetchedSignals = { valid: RawInternListJob[]; stale: number; irrelevant: number };

type BoardConfig = { atsType: string; atsIdentifier: string; careersUrl: string };

async function fetchSignals(now: Date): Promise<FetchedSignals> {
  const out: RawInternListJob[] = [];
  const seen = new Set<string>();
  let stale = 0;
  let irrelevant = 0;
  for (const slug of SLUGS) {
    try {
      const response = await fetch(
        `https://jobright.ai/minisites-jobs/intern/us/${slug}?embed=true`,
        { headers: { "User-Agent": UA }, cache: "no-store", signal: AbortSignal.timeout(20_000) },
      );
      if (!response.ok) continue;
      const nextData = extractNextData(await response.text());
      if (!nextData) continue;
      for (const job of parseInternListPayload(nextData, now)) {
        const key = `${job.company}|${job.title}|${job.location ?? ""}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (!isTargetEngineeringRole(job.title, job.qualifications)) {
          irrelevant += 1;
          continue;
        }
        if (!job.sourcePostedAt) {
          stale += 1;
          continue;
        }
        const age = now.getTime() - job.sourcePostedAt.getTime();
        if (age < 0 || age > 7 * ONE_DAY_MS) {
          stale += 1;
          continue;
        }
        out.push(job);
      }
    } catch {
      // A dead category contributes nothing; the others still measure.
    }
  }
  return {
    valid: out.sort((a, b) => (b.sourcePostedAt?.getTime() ?? 0) - (a.sourcePostedAt?.getTime() ?? 0)),
    stale,
    irrelevant,
  };
}

function readable(atsType: string, atsIdentifier: string | null): boolean {
  if (atsType === "successfactors") return true;
  return Boolean(atsIdentifier) && READABLE.includes(atsType);
}

const boardConfigCache = new Map<string, Promise<BoardConfig | null>>();
const boardJobsCache = new Map<string, Promise<AtsJob[] | null>>();

async function fetchShell(url: string, companyName: string) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return discoverFromRenderedShell(await response.text(), response.url || url, companyName);
  } catch {
    return null;
  }
}

async function discoverBoard(company: string, domain: string): Promise<BoardConfig | null> {
  for (const { host, path } of hostCandidates(domain).flatMap((host) =>
    CAREERS_PATHS.map((path) => ({ host, path })),
  )) {
    const careersUrl = `https://${host}${path}`;
    const detected = await detectAtsForCareersPage(careersUrl);
    if (readable(detected.atsType, detected.atsIdentifier)) {
      return {
        atsType: detected.atsType,
        atsIdentifier: detected.atsIdentifier ?? detected.atsType,
        careersUrl,
      };
    }
  }

  const homepageLinks: string[] = [];
  for (const host of hostCandidates(domain)) {
    homepageLinks.push(...(await careersLinksFromHomepage(host)));
    if (homepageLinks.length > 0) break;
  }
  for (const careersUrl of homepageLinks) {
    const detected = await detectAtsForCareersPage(careersUrl);
    if (readable(detected.atsType, detected.atsIdentifier)) {
      return {
        atsType: detected.atsType,
        atsIdentifier: detected.atsIdentifier ?? detected.atsType,
        careersUrl,
      };
    }
  }

  for (const careersUrl of [
    ...hostCandidates(domain).flatMap((host) => CAREERS_PATHS.map((path) => `https://${host}${path}`)),
    ...homepageLinks,
  ].slice(0, 8)) {
    const shell = await fetchShell(careersUrl, company);
    if (!shell) continue;
    if (
      shell.embeddedAts?.atsIdentifier &&
      readable(shell.embeddedAts.atsType, shell.embeddedAts.atsIdentifier)
    ) {
      return {
        atsType: shell.embeddedAts.atsType,
        atsIdentifier: shell.embeddedAts.atsIdentifier,
        careersUrl,
      };
    }
    if (shell.jobs.length > 0) {
      return { atsType: "spa", atsIdentifier: careersUrl, careersUrl };
    }
    if (shell.officialJobLinks > 0) {
      return { atsType: "employer-page", atsIdentifier: careersUrl, careersUrl };
    }
  }

  const rendered = headlessBudget > 0
    ? await renderCareersPage(homepageLinks[0] ?? `https://${domain}/careers`)
    : null;
  if (rendered) headlessBudget -= 1;
  if (rendered) {
    const linked = detectAtsFromText(rendered.html);
    const client = detectClientRenderedAts(rendered.html, rendered.finalUrl);
    const detected = readable(linked.atsType, linked.atsIdentifier) ? linked : client;
    if (readable(detected.atsType, detected.atsIdentifier)) {
      return {
        atsType: detected.atsType,
        atsIdentifier: detected.atsIdentifier ?? detected.atsType,
        careersUrl: rendered.finalUrl,
      };
    }
    const shell = discoverFromRenderedShell(rendered.html, rendered.finalUrl, company);
    if (shell.jobs.length > 0 || shell.officialJobLinks > 0) {
      return {
        atsType: shell.jobs.length > 0 ? "spa" : "employer-page",
        atsIdentifier: rendered.finalUrl,
        careersUrl: rendered.finalUrl,
      };
    }
  }

  const probed = await resolveAtsForCompany(company, `https://${domain}`, { throttleMs: 100 });
  if (probed) {
    return {
      atsType: probed.atsType,
      atsIdentifier: probed.atsIdentifier,
      careersUrl: `https://${domain}`,
    };
  }
  return null;
}

function boardConfigFor(company: string, domain: string): Promise<BoardConfig | null> {
  const key = normalizeCompanyKey(company);
  let pending = boardConfigCache.get(key);
  if (!pending) {
    pending = discoverBoard(company, domain);
    boardConfigCache.set(key, pending);
  }
  return pending;
}

async function readBoard(config: BoardConfig, companyName: string): Promise<AtsJob[] | null> {
  let jobs: AtsJob[] | null = null;
  try {
    const listed = await listJobsForCompany({
      name: companyName,
      atsType: config.atsType,
      atsIdentifier: config.atsIdentifier,
      careersUrl: config.careersUrl,
      lastETag: null,
      lastModified: null,
      contentHash: null,
    });
    jobs = listed.supported ? listed.jobs : null;
  } catch {
    jobs = null;
  }

  if ((jobs === null || jobs.length === 0) && config.careersUrl) {
    const linked = await listEmployerPageJobs(config.careersUrl, companyName);
    if (linked.length > 0) return linked;
  }

  if ((jobs === null || jobs.length === 0) && BOT_WALLED.has(config.atsType) && headlessBudget > 0) {
    headlessBudget -= 1;
    const url =
      config.atsType === "icims"
        ? `https://${config.atsIdentifier}.icims.com/jobs/search?ss=1&searchKeyword=intern`
        : config.careersUrl;
    const [outcome] = await resolveWithHeadlessBrowser([
      { tenantKey: `${config.atsType}:${config.atsIdentifier}`, url, companyName },
    ]);
    if (outcome && outcome.jobs.length > 0) return outcome.jobs;
  }
  return jobs;
}

function boardJobsFor(config: BoardConfig, companyName: string): Promise<AtsJob[] | null> {
  // SuccessFactors and other shared-host providers do not have an
  // employer-scoped identifier. Match the live pipeline's cache identity so
  // one company's postings can never be served to another benchmark row.
  const key = boardCacheKey({
    atsType: config.atsType,
    atsIdentifier: config.atsIdentifier,
    careersUrl: config.careersUrl,
    name: companyName,
  });
  let pending = boardJobsCache.get(key);
  if (!pending) {
    pending = readBoard(config, companyName);
    boardJobsCache.set(key, pending);
  }
  return pending;
}

type Result =
  | { state: "RESOLVED"; path: string; provider: string; url: string; ms: number; hadJd: boolean }
  | { state: "CLOSED"; url: string }
  | { state: "UNRESOLVED"; reason: FreshSignalReason; detail: string };

async function withDescription(config: BoardConfig, job: AtsJob): Promise<AtsJob> {
  if (job.description && job.description.trim().length > 200) return job;
  try {
    let description: string | null = null;
    if (config.atsType === "eightfold") {
      description = await fetchEightfoldJobDescription(config.atsIdentifier, job.sourceJobId);
    } else if (config.atsType === "phenom") {
      description = await fetchPhenomJobDescription(config.atsIdentifier, job.sourceJobId);
    }
    return description ? { ...job, description } : job;
  } catch {
    return job;
  }
}

async function resolveOne(signal: RawInternListJob): Promise<Result> {
  const started = Date.now();

  const direct = [signal.officialApplicationUrl, signal.originalJobPostUrl, signal.applyUrl].find(
    (value): value is string =>
      Boolean(value) && !isAggregatorUrl(value) && isValidOfficialApplicationUrl(value),
  );
  if (direct) {
    const probe = await probeOfficialJobAvailability(direct);
    if (probe.state === "closed") return { state: "CLOSED", url: direct };
    return {
      state: "RESOLVED",
      path: "direct",
      provider: inferResolvedSource(direct).source,
      url: direct,
      ms: Date.now() - started,
      hadJd: false,
    };
  }

  const detail = await fetchJobrightSignalDetail(signal.sourceJobId);
  if (detail.removedAtSource) {
    return { state: "UNRESOLVED", reason: "POSTING_CLOSED", detail: "source marks removed" };
  }
  if (detail.originalJobPostUrl) {
    const probe = await probeOfficialJobAvailability(detail.originalJobPostUrl);
    if (probe.state === "closed") return { state: "CLOSED", url: detail.originalJobPostUrl };
    return {
      state: "RESOLVED",
      path: "source_original_post",
      provider: inferResolvedSource(detail.originalJobPostUrl).source,
      url: detail.originalJobPostUrl,
      ms: Date.now() - started,
      hadJd: false,
    };
  }
  if (!detail.companyDomain) {
    return { state: "UNRESOLVED", reason: "UNKNOWN_COMPANY", detail: "no source-published domain" };
  }

  const config = await boardConfigFor(signal.company, detail.companyDomain);
  if (!config) {
    return { state: "UNRESOLVED", reason: "NO_ATS_CONFIG", detail: detail.companyDomain };
  }

  const jobs = await boardJobsFor(config, signal.company);
  if (jobs === null || jobs.length === 0) {
    return {
      state: "UNRESOLVED",
      reason: BOT_WALLED.has(config.atsType) ? "BOT_WALL_BLOCKED" : "ATS_BOARD_FETCH_FAILED",
      detail: `${config.atsType}/${config.atsIdentifier} returned no postings`,
    };
  }

  const verdict = classifyOfficialBoardMatch(
    { title: signal.title, location: signal.location },
    jobs,
  );
  if (!verdict.accepted) {
    return {
      state: "UNRESOLVED",
      reason: verdict.reason,
      detail:
        `${config.atsType}/${config.atsIdentifier} of ${jobs.length}` +
        ` bestScore=${verdict.bestScore.toFixed(2)}` +
        ` bestTitle=${verdict.bestTitleSimilarity.toFixed(2)} "${verdict.closestTitle ?? ""}"`,
    };
  }

  if (!isValidOfficialApplicationUrl(verdict.job.applyUrl)) {
    return { state: "UNRESOLVED", reason: "OFFICIAL_URL_REJECTED", detail: verdict.job.applyUrl };
  }

  const hydrated = await withDescription(config, verdict.job);
  const probe = await probeOfficialJobAvailability(hydrated.applyUrl);
  if (probe.state === "closed") return { state: "CLOSED", url: hydrated.applyUrl };
  return {
    state: "RESOLVED",
    path: "employer_board",
    provider: inferResolvedSource(hydrated.applyUrl, config.atsType).source,
    url: hydrated.applyUrl,
    ms: Date.now() - started,
    hadJd: hydrated.description.trim().length > 200,
  };
}

async function main() {
  const explicitLimit = process.argv.find((value) => value.startsWith("--limit="))?.slice("--limit=".length);
  const sampleSize = Number.parseInt(explicitLimit ?? process.argv.find((value) => /^\d+$/.test(value)) ?? "30", 10) || 30;
  const now = new Date();
  const fetched = await fetchSignals(now);
  const signals = fetched.valid;
  const sample = signals.slice(0, sampleSize);

  // The catalog comparison is read-only. The benchmark dataset itself is a
  // disposable JSON artifact, so no radar fixture can mutate product rows.
  const catalogRows = await prisma.job.findMany({
    where: { activeFeed: true, verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK" },
    select: {
      sourceJobId: true, requisitionId: true, title: true, company: true,
      location: true, workplaceType: true, officialApplicationUrl: true,
      description: true, sourcePostedAt: true,
    },
  });
  const catalogByCompany = new Map<string, AtsJob[]>();
  for (const row of catalogRows) {
    if (!row.officialApplicationUrl) continue;
    const key = normalizeCompanyKey(row.company);
    const jobs = catalogByCompany.get(key) ?? [];
    jobs.push({
      sourceJobId: row.sourceJobId ?? row.requisitionId ?? row.officialApplicationUrl,
      requisitionId: row.requisitionId,
      title: row.title,
      company: row.company,
      location: row.location,
      workplaceType: row.workplaceType,
      applyUrl: row.officialApplicationUrl,
      description: row.description,
      postedAt: row.sourcePostedAt,
    });
    catalogByCompany.set(key, jobs);
  }

  console.log(`fresh signals available: ${signals.length}`);
  console.log(
    `  <24h ${signals.filter((s) => now.getTime() - s.sourcePostedAt!.getTime() <= ONE_DAY_MS).length}` +
      `  <72h ${signals.filter((s) => now.getTime() - s.sourcePostedAt!.getTime() <= 3 * ONE_DAY_MS).length}`,
  );
  console.log(`measuring ${sample.length} of them\n`);

  const reasons = emptyReasonCounts();
  const times: number[] = [];
  const urls = new Set<string>();
  const byPath: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  let resolved = 0;
  let closed = 0;
  let withJd = 0;
  let alreadyFoundOfficially = 0;
  let resolvedAfterPriorityTrigger = 0;
  let officialExistsButMatchFailed = 0;
  let supportedReachableDenominator = 0;
  let supportedReachableCanonical = 0;
  const datasetRows: Array<Record<string, unknown>> = [];

  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, sample.length) }, async () => {
    while (cursor < sample.length) {
      const signal = sample[cursor++]!;
      const catalogJobs = catalogByCompany.get(normalizeCompanyKey(signal.company)) ?? [];
      const existing = catalogJobs.length > 0
        ? classifyOfficialBoardMatch({ title: signal.title, location: signal.location }, catalogJobs)
        : null;
      if (existing?.accepted) {
        alreadyFoundOfficially += 1;
        resolved += 1;
        supportedReachableDenominator += 1;
        supportedReachableCanonical += 1;
        urls.add(existing.job.applyUrl);
        if (existing.job.description.trim().length > 200) withJd += 1;
        datasetRows.push({
          sourceJobId: signal.sourceJobId,
          company: signal.company,
          title: signal.title,
          location: signal.location,
          sourcePostedAt: signal.sourcePostedAt?.toISOString() ?? null,
          classification: "ALREADY_FOUND_OFFICIALLY",
          officialUrl: existing.job.applyUrl,
        });
        console.log(`  HAVE [catalog] ${signal.company} â€” ${signal.title}`);
        continue;
      }
      let result: Result;
      try {
        result = await resolveOne(signal);
      } catch (error) {
        result = {
          state: "UNRESOLVED",
          reason: "NETWORK_FAILURE",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (result.state === "RESOLVED") {
        resolved += 1;
        supportedReachableDenominator += 1;
        supportedReachableCanonical += 1;
        resolvedAfterPriorityTrigger += 1;
        times.push(result.ms);
        urls.add(result.url);
        byPath[result.path] = (byPath[result.path] ?? 0) + 1;
        byProvider[result.provider] = (byProvider[result.provider] ?? 0) + 1;
        if (result.hadJd) withJd += 1;
        datasetRows.push({
          sourceJobId: signal.sourceJobId,
          company: signal.company,
          title: signal.title,
          location: signal.location,
          sourcePostedAt: signal.sourcePostedAt?.toISOString() ?? null,
          classification: "RESOLVED_AFTER_PRIORITY_TRIGGER",
          officialUrl: result.url,
          provider: result.provider,
        });
        console.log(
          `  OK   [${result.provider}${result.hadJd ? "+jd" : ""}] ${signal.company} — ${signal.title}\n       ${result.url}`,
        );
      } else if (result.state === "CLOSED") {
        closed += 1;
        datasetRows.push({ sourceJobId: signal.sourceJobId, company: signal.company, title: signal.title, classification: "SOURCE_SIGNAL_STALE" });
        console.log(`  DEAD ${signal.company} — ${signal.title}`);
      } else {
        countReason(reasons, result.reason);
        const classification = ["NO_BOARD_MATCH", "TITLE_MATCH_TOO_LOW", "LOCATION_MISMATCH"].includes(result.reason)
          ? "OFFICIAL_JOB_EXISTS_BUT_MATCH_FAILED"
          : "UNRESOLVED";
        if (classification === "OFFICIAL_JOB_EXISTS_BUT_MATCH_FAILED") officialExistsButMatchFailed += 1;
        const supportedReachable = ![
          "NO_ATS_CONFIG",
          "UNKNOWN_COMPANY",
          "BOT_WALL_BLOCKED",
          "PROVIDER_ACCESS_BLOCKED",
        ].includes(result.reason);
        if (supportedReachable) supportedReachableDenominator += 1;
        datasetRows.push({
          sourceJobId: signal.sourceJobId,
          company: signal.company,
          title: signal.title,
          location: signal.location,
          sourcePostedAt: signal.sourcePostedAt?.toISOString() ?? null,
          classification,
          reason: result.reason,
          detail: result.detail,
        });
        console.log(`  --   ${signal.company} — ${signal.title}  [${result.reason}] ${result.detail}`);
      }
    }
  });
  await Promise.all(workers);

  const outputArg = process.argv.find((value) => value.startsWith("--output="))?.slice("--output=".length);
  const outputPath = path.resolve(outputArg || "data/generated/fresh-official-benchmark.json");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify({
    generatedAt: now.toISOString(),
    source: "jobright-public-radar",
    availableValidSignals: signals.length,
    freshUnder24h: signals.filter((signal) => now.getTime() - signal.sourcePostedAt!.getTime() <= ONE_DAY_MS).length,
    freshUnder72h: signals.filter((signal) => now.getTime() - signal.sourcePostedAt!.getTime() <= 3 * ONE_DAY_MS).length,
    validSignalDenominator: sample.length,
    sourceSignalStale: fetched.stale + closed,
    sourceSignalIrrelevant: fetched.irrelevant,
    alreadyFoundOfficially,
    resolvedAfterPriorityTrigger,
    officialJobExistsButMatchFailed: officialExistsButMatchFailed,
    unresolved: sample.length - resolved - closed - officialExistsButMatchFailed,
    trueRecallPercent: sample.length ? Number(((resolved / sample.length) * 100).toFixed(2)) : 0,
    supportedReachableDenominator,
    supportedReachableCanonical,
    supportedReachableRecallPercent: supportedReachableDenominator
      ? Number((supportedReachableCanonical / supportedReachableDenominator * 100).toFixed(2))
      : 0,
    resolvedWithFullJd: withJd,
    rows: datasetRows,
  }, null, 2));

  const sorted = [...times].sort((a, b) => a - b);
  const medianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const pct = (part: number, whole: number) =>
    whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;

  console.log("\n" + "=".repeat(60));
  console.log(`examined            ${sample.length}`);
  console.log(`officially resolved ${resolved} (${pct(resolved, sample.length)})`);
  console.log(`supported/reachable ${supportedReachableCanonical}/${supportedReachableDenominator} (${pct(supportedReachableCanonical, supportedReachableDenominator)})`);
  console.log(`  ALREADY_FOUND_OFFICIALLY          ${alreadyFoundOfficially}`);
  console.log(`  RESOLVED_AFTER_PRIORITY_TRIGGER   ${resolvedAfterPriorityTrigger}`);
  console.log(`  OFFICIAL_JOB_EXISTS_MATCH_FAILED  ${officialExistsButMatchFailed}`);
  console.log(`  by path           ${JSON.stringify(byPath)}`);
  console.log(`  by provider       ${JSON.stringify(byProvider)}`);
  console.log(`  with a real JD    ${withJd} (${pct(withJd, resolved)} of resolved)`);
  console.log(`closed at source    ${closed}`);
  console.log(`stale source rows   ${fetched.stale}`);
  console.log(`irrelevant rows     ${fetched.irrelevant}`);
  console.log(`unresolved          ${sample.length - resolved - closed - officialExistsButMatchFailed}`);
  console.log(`distinct URLs       ${urls.size} (duplicates collapsed: ${resolved - urls.size})`);
  console.log(`median resolve ms   ${medianMs ?? "n/a"}`);
  console.log(`reasons             ${formatReasonCounts(reasons)}`);
  console.log(`dataset             ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
