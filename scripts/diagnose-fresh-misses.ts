import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@/lib/db";
import { detectAtsFromText, detectClientRenderedAts } from "@/lib/ats/detect";
import type { AtsJob } from "@/lib/ats/types";
import { classifyOfficialBoardMatch } from "@/lib/sync/officialBoardMatch";
import { normalizeCompanyKey } from "@/lib/sync/freshSignalReasons";
import {
  fetchJobrightFreshSignals,
  directOfficialUrlFrom,
  officialSearchDecision,
  boardJobsFor,
  type BoardCache,
  type OfficialCatalogEntry,
  type OfficialCatalogIndex,
} from "@/lib/sync/jobrightFreshDiscovery";
import { fetchJobrightSignalDetail } from "@/lib/sync/jobrightSignalDetail";
import {
  loadApprovedCompanyIndex,
  findApprovedCompany,
  careersLinksFromHomepage,
  discoverEmployerBoardConfig,
  hostCandidates,
} from "@/lib/sync/employerBoardResolution";
import { isTargetEngineeringRole } from "@/lib/sync/classify";

/**
 * Why every missed fresh signal missed.
 *
 *   npx tsx scripts/diagnose-fresh-misses.ts [--limit=60] [--output=path]
 *
 * The recall benchmark says how many signals resolved. It does not say what
 * would have to change for the rest to resolve, and without that the only way
 * to raise recall is to guess at adapters. This walks the same components the
 * live pipeline uses, but records the state at every step rather than only the
 * verdict — registry hit, published domain, which host answered, what platform
 * signature the page carried, whether the board could be read, how many
 * candidate postings came back, and the best match score against them.
 *
 * It is READ-ONLY with respect to the catalogue and the resolution cache. It
 * deliberately does not call resolveEmployerBoard, because that answers from a
 * negative-backoff cache: for a diagnostic the question is what is true now,
 * not what was true when the employer was last given up on.
 *
 * The second half is the part that pays for itself: for every employer the
 * production cascade cannot configure, it probes the hosts the cascade does
 * NOT currently try (careers.x, jobs.x, …) and reports the platform signature
 * it finds there. That is what turns "329 custom employers" into a ranked list
 * of reusable platforms.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CONCURRENCY = 6;

/** --no-discovery reproduces the cached-verdict view, for before/after runs. */
const NO_DISCOVERY = process.argv.includes("--no-discovery");

/** Paths the production cascade already tries. */
const KNOWN_PATHS = ["/careers", "/careers/jobs", "/jobs", "/company/careers", "/about/careers", "/en/careers", "/"];

/**
 * Hosts the production cascade does NOT try today. `hostCandidates` returns
 * only the domain and its apex, so an employer whose careers site lives at
 * careers.<apex> or jobs.<apex> is reachable only through the homepage-link
 * pass — which fails whenever the corporate homepage is bot-protected or
 * renders its navigation in JavaScript.
 */
function unexploredHosts(domain: string): string[] {
  const known = new Set(hostCandidates(domain));
  const out: string[] = [];
  for (const base of hostCandidates(domain)) {
    for (const prefix of ["careers", "jobs", "careers-home", "apply", "talent", "recruiting"]) {
      const host = `${prefix}.${base}`;
      if (!known.has(host)) out.push(host);
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Extra platform signatures — detection only, no adapter is claimed
// ---------------------------------------------------------------------------

/**
 * Signatures for systems this codebase has no adapter for yet. Detecting them
 * costs nothing and is the entire point of the exercise: it converts an opaque
 * "Custom/API" bucket into named platforms with employer counts behind them,
 * so the next adapter is chosen by expected recovery rather than by guess.
 */
const EXTRA_PLATFORMS: { name: string; regex: RegExp }[] = [
  { name: "oracle-recruiting-cloud", regex: /\.oraclecloud\.com\/hcmUI\/CandidateExperience|\/hcmUI\/CandidateExperience/i },
  { name: "oracle-taleo", regex: /taleo\.net|tbe\.taleo\.net/i },
  { name: "avature", regex: /\.avature\.net|avature\.com\/careers/i },
  { name: "jobvite", regex: /jobs\.jobvite\.com|jobvite\.com\/careers/i },
  { name: "workable", regex: /apply\.workable\.com|workable\.com\/j\//i },
  { name: "recruitee", regex: /\.recruitee\.com/i },
  { name: "dayforce", regex: /dayforcehcm\.com\/CandidatePortal|ceridian\.com/i },
  { name: "brassring", regex: /brassring\.com|krb-sjobs\.brassring/i },
  { name: "paylocity", regex: /recruiting\.paylocity\.com/i },
  { name: "paycom", regex: /paycomonline\.net\/v4\/ats/i },
  { name: "ultipro", regex: /recruiting\d*\.ultipro\.com/i },
  { name: "adp-workforcenow", regex: /workforcenow\.adp\.com\/mascsr/i },
  { name: "teamtailor", regex: /\.teamtailor\.com/i },
  { name: "greenhouse-embed", regex: /grnhse\.io|greenhouse\.io\/embed/i },
  { name: "json-ld-jobposting", regex: /"@type"\s*:\s*"JobPosting"/i },
  { name: "next-data", regex: /id="__NEXT_DATA__"/i },
  { name: "apple-jobs-api", regex: /jobs\.apple\.com|"searchResults"\s*:/i },
  { name: "graphql-jobs-api", regex: /\/graphql[^"'\s]*\b(job|career|search)/i },
];

function detectExtraPlatforms(html: string, finalUrl: string): string[] {
  const haystack = `${finalUrl}\n${html.slice(0, 400_000)}`;
  return EXTRA_PLATFORMS.filter((platform) => platform.regex.test(haystack)).map((platform) => platform.name);
}

type ProbeHit = {
  url: string;
  finalUrl: string;
  status: number;
  supportedAts: string | null;
  supportedIdentifier: string | null;
  extraPlatforms: string[];
};

async function probeUrl(url: string): Promise<ProbeHit | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": UA, accept: "text/html" },
      signal: AbortSignal.timeout(12_000),
    });
    const finalUrl = res.url || url;
    const fromUrl = detectAtsFromText(finalUrl);
    let html = "";
    if (res.ok) html = await res.text();
    const linked = fromUrl.atsType !== "unknown" ? fromUrl : detectAtsFromText(html);
    const client = linked.atsType !== "unknown" ? linked : detectClientRenderedAts(html, finalUrl);

    return {
      url,
      finalUrl,
      status: res.status,
      supportedAts: client.atsType !== "unknown" ? client.atsType : null,
      supportedIdentifier: client.atsIdentifier,
      extraPlatforms: detectExtraPlatforms(html, finalUrl),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-signal diagnosis
// ---------------------------------------------------------------------------

type SignalDiagnosis = {
  company: string;
  title: string;
  location: string | null;
  radarSource: string;
  radarPostedAt: string | null;
  sourceJobId: string;

  /** Stage the signal reached before it stopped. */
  outcome:
    | "ALREADY_OFFICIAL"
    | "DIRECT_OFFICIAL_URL"
    | "SOURCE_ORIGINAL_POST"
    | "BOARD_MATCHED"
    | "MISS";
  failureReason: string | null;

  inRegistry: boolean;
  registryAtsType: string | null;
  registryAtsIdentifier: string | null;
  registryConfigState: string | null;

  publishedDomain: string | null;
  cachedResolutionState: string | null;
  cachedResolutionReason: string | null;
  cachedAtsType: string | null;

  boardConfigured: boolean;
  boardAtsType: string | null;
  boardIdentifier: string | null;
  boardCareersUrl: string | null;
  boardReachable: boolean | null;
  boardPostings: number | null;

  bestScore: number | null;
  bestTitleSimilarity: number | null;
  closestTitle: string | null;

  /** What an unexplored host would have revealed. Only filled for misses. */
  probes: ProbeHit[];
  recoverablePlatforms: string[];
  recoverableSupportedAts: string | null;
  /** Set when the live cascade configured this employer during the run. */
  discoveredNow: string | null;
  botWalled: boolean;
};

async function buildOfficialCatalogIndex(): Promise<OfficialCatalogIndex> {
  const jobs = await prisma.job.findMany({
    where: {
      activeFeed: true,
      verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
      officialApplicationUrl: { not: null },
    },
    select: {
      id: true, source: true, sourceJobId: true, requisitionId: true,
      title: true, company: true, location: true, workplaceType: true,
      officialApplicationUrl: true, description: true,
      sourcePostedAt: true, sourcePostedText: true,
    },
  });
  const index: OfficialCatalogIndex = new Map();
  for (const job of jobs) {
    if (!job.officialApplicationUrl) continue;
    const entry: OfficialCatalogEntry = {
      jobId: job.id,
      provider: job.source ?? "other",
      hasEmployerJd: job.description.trim().length > 200,
      sourceJobId: job.sourceJobId ?? job.id,
      requisitionId: job.requisitionId,
      title: job.title,
      company: job.company,
      location: job.location,
      workplaceType: job.workplaceType,
      applyUrl: job.officialApplicationUrl,
      description: job.description,
      postedAt: job.sourcePostedAt,
      postedAtText: job.sourcePostedText,
    };
    const key = normalizeCompanyKey(job.company);
    const bucket = index.get(key) ?? [];
    bucket.push(entry);
    index.set(key, bucket);
  }
  return index;
}

async function diagnose(
  signal: { company: string; title: string; location: string | null; sourceJobId: string; sourcePostedAt: Date | null; sourceUrl?: string | null },
  catalog: OfficialCatalogIndex,
  boardCache: BoardCache,
  approved: Map<string, Awaited<ReturnType<typeof loadApprovedCompanyIndex>> extends Map<string, infer V> ? V : never>,
): Promise<SignalDiagnosis> {
  const base: SignalDiagnosis = {
    company: signal.company,
    title: signal.title,
    location: signal.location,
    radarSource: "jobright",
    radarPostedAt: signal.sourcePostedAt?.toISOString() ?? null,
    sourceJobId: signal.sourceJobId,
    outcome: "MISS",
    failureReason: null,
    inRegistry: false,
    registryAtsType: null,
    registryAtsIdentifier: null,
    registryConfigState: null,
    publishedDomain: null,
    cachedResolutionState: null,
    cachedResolutionReason: null,
    cachedAtsType: null,
    boardConfigured: false,
    boardAtsType: null,
    boardIdentifier: null,
    boardCareersUrl: null,
    boardReachable: null,
    boardPostings: null,
    bestScore: null,
    bestTitleSimilarity: null,
    closestTitle: null,
    probes: [],
    recoverablePlatforms: [],
    recoverableSupportedAts: null,
    discoveredNow: null,
    botWalled: false,
  };

  // Registry state.
  const registry = findApprovedCompany(signal.company, approved);
  if (registry) {
    base.inRegistry = true;
    base.registryAtsType = registry.atsType;
    base.registryAtsIdentifier = registry.atsIdentifier;
  }
  const companyRow = await prisma.company.findFirst({
    where: { name: { equals: signal.company, mode: "insensitive" } },
    select: { atsConfigState: true },
  });
  base.registryConfigState = companyRow?.atsConfigState ?? null;

  // Already in the official catalogue?
  const decision = officialSearchDecision(signal, catalog);
  if (decision.action === "attach_existing") {
    base.outcome = "ALREADY_OFFICIAL";
    return base;
  }

  // Feed-stated official destination.
  if (directOfficialUrlFrom(signal as never)) {
    base.outcome = "DIRECT_OFFICIAL_URL";
    return base;
  }

  const detail = signal.sourceJobId.startsWith("intern-list-public:")
    ? null
    : await fetchJobrightSignalDetail(signal.sourceJobId);
  base.publishedDomain = detail?.companyDomain ?? null;
  if (detail?.originalJobPostUrl) {
    base.outcome = "SOURCE_ORIGINAL_POST";
    return base;
  }

  // Cached resolution (read-only — never written by this diagnostic).
  const key = normalizeCompanyKey(signal.company);
  const cached = key
    ? await prisma.employerBoardResolution.findUnique({ where: { normalizedCompany: key } })
    : null;
  base.cachedResolutionState = cached?.state ?? null;
  base.cachedResolutionReason = cached?.reasonCode ?? null;
  base.cachedAtsType = cached?.atsType ?? null;

  // What configuration would the pipeline actually have?
  const domain = base.publishedDomain ?? cached?.companyDomain ?? null;

  let config =
    registry?.atsType && registry.atsType !== "unknown" && registry.atsType !== "custom" && registry.atsIdentifier
      ? { atsType: registry.atsType, atsIdentifier: registry.atsIdentifier, careersUrl: registry.careersUrl }
      : cached?.state === "RESOLVED" && cached.atsType && cached.atsIdentifier
        ? { atsType: cached.atsType, atsIdentifier: cached.atsIdentifier, careersUrl: cached.careersUrl }
        : null;

  // No usable configuration on record — run the REAL discovery cascade rather
  // than the cached verdict. A negative cache entry says what was true when the
  // employer was last attempted, which is the wrong question here.
  if (!config && domain && !NO_DISCOVERY) {
    try {
      const discovered = await discoverEmployerBoardConfig(signal.company, domain);
      if (discovered) {
        config = {
          atsType: discovered.atsType,
          atsIdentifier: discovered.atsIdentifier,
          careersUrl: discovered.careersUrl,
        };
        base.discoveredNow = JSON.parse(discovered.evidence)?.method ?? "discovered";
      }
    } catch {
      // Discovery failure is itself the diagnosis; recorded as NO_ATS_CONFIG.
    }
  }

  if (config) {
    base.boardConfigured = true;
    base.boardAtsType = config.atsType;
    base.boardIdentifier = config.atsIdentifier;
    base.boardCareersUrl = config.careersUrl;

    // The production reader, fallbacks included.
    const read = await boardJobsFor(
      {
        name: signal.company,
        atsType: config.atsType,
        atsIdentifier: config.atsIdentifier,
        careersUrl: config.careersUrl,
        lastETag: null,
        lastModified: null,
        contentHash: null,
        origin: "discovered" as const,
      },
      signal.company,
      boardCache,
    );
    const jobs: AtsJob[] = read.jobs;
    base.boardReachable = !read.fetchFailed;
    base.botWalled = read.botWalled;
    base.boardPostings = jobs.length;

    if (jobs.length > 0) {
      const verdict = classifyOfficialBoardMatch({ title: signal.title, location: signal.location }, jobs);
      base.bestScore = verdict.accepted ? 1 : verdict.bestScore;
      base.bestTitleSimilarity = verdict.accepted ? 1 : verdict.bestTitleSimilarity;
      base.closestTitle = verdict.accepted ? verdict.job.title : verdict.closestTitle;
      if (verdict.accepted) {
        base.outcome = "BOARD_MATCHED";
        return base;
      }
      base.failureReason = verdict.reason;
      return base;
    }
    base.failureReason = base.botWalled ? "BOT_WALL_BLOCKED" : "ATS_BOARD_FETCH_FAILED";
  } else {
    base.failureReason = domain ? "NO_ATS_CONFIG" : "UNKNOWN_COMPANY";
  }

  // ---- The recovery probe -------------------------------------------------
  // Only for misses, and only over hosts the production cascade does not try.
  if (domain) {
    const targets: string[] = [];
    for (const host of unexploredHosts(domain)) targets.push(`https://${host}/`);
    for (const host of hostCandidates(domain)) {
      for (const p of ["/careers/students", "/careers/university", "/en-us/careers", "/careers/search"]) {
        if (!KNOWN_PATHS.includes(p)) targets.push(`https://${host}${p}`);
      }
    }

    const hits: ProbeHit[] = [];
    for (const target of targets.slice(0, 10)) {
      const hit = await probeUrl(target);
      if (!hit) continue;
      if (hit.status >= 400) continue;
      if (hit.supportedAts || hit.extraPlatforms.length > 0) hits.push(hit);
      if (hit.supportedAts) break;
    }

    // Also: the homepage careers links, checked for the EXTRA platforms the
    // production detector does not know about. This is how a "custom" employer
    // turns out to be Oracle Recruiting Cloud.
    if (hits.length === 0) {
      for (const link of (await careersLinksFromHomepage(domain)).slice(0, 4)) {
        const hit = await probeUrl(link);
        if (hit && (hit.supportedAts || hit.extraPlatforms.length > 0)) {
          hits.push(hit);
          if (hit.supportedAts) break;
        }
      }
    }

    base.probes = hits;
    base.recoverablePlatforms = [...new Set(hits.flatMap((hit) => hit.extraPlatforms))];
    base.recoverableSupportedAts = hits.find((hit) => hit.supportedAts)?.supportedAts ?? null;
  }

  return base;
}

// ---------------------------------------------------------------------------

function pct(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
}

async function main() {
  const limit = Number.parseInt(
    process.argv.find((value) => value.startsWith("--limit="))?.slice(8) ?? "60",
    10,
  ) || 60;

  const now = new Date();
  console.log(`[miss-diagnostic] ${now.toISOString()}`);
  const source = await fetchJobrightFreshSignals(now);
  const valid = source.jobs.filter((job) => isTargetEngineeringRole(job.title, job.qualifications));
  const offset = Number.parseInt(process.argv.find((v) => v.startsWith("--offset="))?.slice(9) ?? "0", 10) || 0;
  const sample = valid.slice(offset, offset + limit);

  console.log(
    `signals fetched=${source.jobs.length} valid=${valid.length} <24h=${source.freshUnder24h} <72h=${source.freshUnder72h} sample=${sample.length} offset=${offset}`,
  );

  const [catalog, approved] = await Promise.all([buildOfficialCatalogIndex(), loadApprovedCompanyIndex()]);
  const boardCache: BoardCache = new Map();
  console.log(`official catalogue employers indexed = ${catalog.size}; approved registry = ${approved.size}`);

  const rows: SignalDiagnosis[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, sample.length) }, async () => {
      while (cursor < sample.length) {
        const signal = sample[cursor++]!;
        try {
          const row = await diagnose(signal, catalog, boardCache, approved);
          rows.push(row);
          const mark = row.outcome === "MISS" ? `--   ${row.failureReason}` : `OK   ${row.outcome}`;
          const extra = row.recoverableSupportedAts
            ? ` RECOVERABLE:${row.recoverableSupportedAts}`
            : row.recoverablePlatforms.length
              ? ` PLATFORM:${row.recoverablePlatforms.join("+")}`
              : "";
          console.log(`  ${mark.padEnd(28)} ${row.company} — ${row.title}${extra}`);
        } catch (error) {
          console.error(`  !!   ${signal.company}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }),
  );

  // ---- Aggregates --------------------------------------------------------
  const resolved = rows.filter((row) => row.outcome !== "MISS");
  const misses = rows.filter((row) => row.outcome === "MISS");

  const byReason = new Map<string, number>();
  for (const miss of misses) byReason.set(miss.failureReason ?? "UNKNOWN", (byReason.get(miss.failureReason ?? "UNKNOWN") ?? 0) + 1);

  const byPlatform = new Map<string, { employers: Set<string>; signals: number }>();
  for (const miss of misses) {
    const labels = miss.recoverableSupportedAts
      ? [`SUPPORTED:${miss.recoverableSupportedAts}`]
      : miss.recoverablePlatforms.length
        ? miss.recoverablePlatforms
        : ["none-detected"];
    for (const label of labels) {
      const entry = byPlatform.get(label) ?? { employers: new Set<string>(), signals: 0 };
      entry.employers.add(miss.company);
      entry.signals += 1;
      byPlatform.set(label, entry);
    }
  }

  const byEmployer = new Map<string, { signals: number; reason: string | null; recoverable: string | null }>();
  for (const miss of misses) {
    const entry = byEmployer.get(miss.company) ?? { signals: 0, reason: miss.failureReason, recoverable: null };
    entry.signals += 1;
    entry.recoverable = miss.recoverableSupportedAts ?? miss.recoverablePlatforms[0] ?? entry.recoverable;
    byEmployer.set(miss.company, entry);
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`examined            ${rows.length}`);
  console.log(`resolved            ${resolved.length} (${pct(resolved.length, rows.length)})`);
  for (const outcome of ["ALREADY_OFFICIAL", "DIRECT_OFFICIAL_URL", "SOURCE_ORIGINAL_POST", "BOARD_MATCHED"]) {
    const count = resolved.filter((row) => row.outcome === outcome).length;
    if (count) console.log(`  ${outcome.padEnd(22)}${count}`);
  }
  console.log(`missed              ${misses.length}`);
  console.log(`\nfailure reasons`);
  for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(26)}${count}`);
  }

  console.log(`\nPLATFORM CLUSTERS behind the misses (probe of hosts the pipeline does not try)`);
  for (const [platform, entry] of [...byPlatform].sort((a, b) => b[1].signals - a[1].signals)) {
    console.log(
      `  ${platform.padEnd(30)} signals=${String(entry.signals).padEnd(4)} employers=${entry.employers.size}  ${[...entry.employers].slice(0, 6).join(", ")}`,
    );
  }

  console.log(`\nTOP MISSED EMPLOYERS`);
  for (const [company, entry] of [...byEmployer].sort((a, b) => b[1].signals - a[1].signals).slice(0, 25)) {
    console.log(
      `  ${String(entry.signals).padStart(2)}  ${company.padEnd(32)} ${(entry.reason ?? "").padEnd(24)} ${entry.recoverable ?? ""}`,
    );
  }

  const outputArg = process.argv.find((value) => value.startsWith("--output="))?.slice(9);
  const outputPath = path.resolve(outputArg || "data/generated/fresh-miss-dataset.json");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        generatedAt: now.toISOString(),
        signalsFetched: source.jobs.length,
        validSignals: valid.length,
        examined: rows.length,
        resolved: resolved.length,
        recallPercent: rows.length ? Number(((resolved.length / rows.length) * 100).toFixed(2)) : 0,
        failureReasons: Object.fromEntries(byReason),
        platformClusters: Object.fromEntries(
          [...byPlatform].map(([name, entry]) => [name, { signals: entry.signals, employers: [...entry.employers] }]),
        ),
        rows,
      },
      null,
      2,
    ),
  );
  console.log(`\ndataset             ${outputPath}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
