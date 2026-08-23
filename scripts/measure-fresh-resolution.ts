// Dry-run measurement of the fresh radar's official-resolution rate.
//
//   npx tsx scripts/measure-fresh-resolution.ts [sampleSize]
//
// This runs the REAL resolution pipeline — detail enrichment, employer domain,
// careers-page crawl, client-rendered vendor detection, ATS board read,
// title/location match, availability probe, JD fetch — against live public
// signals, but writes NOTHING to the database and needs no running database at
// all. It exists so the resolution percentage can be measured honestly without
// starting the full local stack.

import "dotenv/config";
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

type BoardConfig = { atsType: string; atsIdentifier: string; careersUrl: string };

async function fetchSignals(now: Date): Promise<RawInternListJob[]> {
  const out: RawInternListJob[] = [];
  const seen = new Set<string>();
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
        if (!job.sourcePostedAt) continue;
        const age = now.getTime() - job.sourcePostedAt.getTime();
        if (age < 0 || age > 7 * ONE_DAY_MS) continue;
        if (!isTargetEngineeringRole(job.title, job.qualifications)) continue;
        const key = `${job.company}|${job.title}|${job.location ?? ""}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(job);
      }
    } catch {
      // A dead category contributes nothing; the others still measure.
    }
  }
  return out.sort(
    (a, b) => (b.sourcePostedAt?.getTime() ?? 0) - (a.sourcePostedAt?.getTime() ?? 0),
  );
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

  const rendered = await renderCareersPage(homepageLinks[0] ?? `https://${domain}/careers`);
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

  if ((jobs === null || jobs.length === 0) && BOT_WALLED.has(config.atsType)) {
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
  const key = `${config.atsType}:${config.atsIdentifier}`;
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
  const sampleSize = Number.parseInt(process.argv[2] ?? "30", 10) || 30;
  const now = new Date();
  const signals = await fetchSignals(now);
  const sample = signals.slice(0, sampleSize);

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

  let cursor = 0;
  const workers = Array.from({ length: Math.min(6, sample.length) }, async () => {
    while (cursor < sample.length) {
      const signal = sample[cursor++]!;
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
        times.push(result.ms);
        urls.add(result.url);
        byPath[result.path] = (byPath[result.path] ?? 0) + 1;
        byProvider[result.provider] = (byProvider[result.provider] ?? 0) + 1;
        if (result.hadJd) withJd += 1;
        console.log(
          `  OK   [${result.provider}${result.hadJd ? "+jd" : ""}] ${signal.company} — ${signal.title}\n       ${result.url}`,
        );
      } else if (result.state === "CLOSED") {
        closed += 1;
        console.log(`  DEAD ${signal.company} — ${signal.title}`);
      } else {
        countReason(reasons, result.reason);
        console.log(`  --   ${signal.company} — ${signal.title}  [${result.reason}] ${result.detail}`);
      }
    }
  });
  await Promise.all(workers);

  const sorted = [...times].sort((a, b) => a - b);
  const medianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const pct = (part: number, whole: number) =>
    whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;

  console.log("\n" + "=".repeat(60));
  console.log(`examined            ${sample.length}`);
  console.log(`officially resolved ${resolved} (${pct(resolved, sample.length)})`);
  console.log(`  by path           ${JSON.stringify(byPath)}`);
  console.log(`  by provider       ${JSON.stringify(byProvider)}`);
  console.log(`  with a real JD    ${withJd} (${pct(withJd, resolved)} of resolved)`);
  console.log(`closed at source    ${closed}`);
  console.log(`unresolved          ${sample.length - resolved - closed}`);
  console.log(`distinct URLs       ${urls.size} (duplicates collapsed: ${resolved - urls.size})`);
  console.log(`median resolve ms   ${medianMs ?? "n/a"}`);
  console.log(`reasons             ${formatReasonCounts(reasons)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
