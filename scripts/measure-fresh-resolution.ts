// Dry-run measurement of the fresh radar's official-resolution rate.
//
//   npx tsx scripts/measure-fresh-resolution.ts [sampleSize]
//
// This runs the REAL resolution pipeline — detail enrichment, employer domain,
// careers-page crawl, ATS board read, title/location match, availability probe
// — against live public signals, but writes NOTHING to the database and needs
// no running database at all. It exists so the resolution percentage can be
// measured honestly without starting the full local stack.

import "dotenv/config";
import { listJobsForCompany } from "@/lib/ats";
import type { AtsJob } from "@/lib/ats/types";
import { detectAtsForCareersPage } from "@/lib/ats/detect";
import { careersLinksFromHomepage } from "@/lib/sync/employerBoardResolution";
import { resolveAtsForCompany } from "@/lib/ats/resolve";
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
import { isAggregatorUrl, isValidOfficialApplicationUrl } from "@/lib/applications/officialDestination";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SLUGS = ["engineering_development", "data_engineer", "data_science"];
const CAREERS_PATHS = ["/careers", "/careers/jobs", "/jobs", "/company/careers", "/"];
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

const boardConfigCache = new Map<string, BoardConfig | null>();
const boardJobsCache = new Map<string, AtsJob[] | null>();

async function boardConfigFor(company: string, domain: string): Promise<BoardConfig | null> {
  const key = normalizeCompanyKey(company);
  if (boardConfigCache.has(key)) return boardConfigCache.get(key)!;

  let found: BoardConfig | null = null;
  for (const path of CAREERS_PATHS) {
    const careersUrl = `https://${domain}${path}`;
    const detected = await detectAtsForCareersPage(careersUrl);
    const readable =
      detected.atsType === "successfactors" ||
      (Boolean(detected.atsIdentifier) &&
        ["greenhouse", "lever", "ashby", "smartrecruiters", "workday", "icims", "taleo"].includes(
          detected.atsType,
        ));
    if (!readable) continue;
    found = {
      atsType: detected.atsType,
      atsIdentifier: detected.atsIdentifier ?? detected.atsType,
      careersUrl,
    };
    break;
  }
  if (!found) {
    for (const careersUrl of await careersLinksFromHomepage(domain)) {
      const detected = await detectAtsForCareersPage(careersUrl);
      const readable =
        detected.atsType === "successfactors" ||
        (Boolean(detected.atsIdentifier) &&
          ["greenhouse", "lever", "ashby", "smartrecruiters", "workday", "icims", "taleo"].includes(
            detected.atsType,
          ));
      if (!readable) continue;
      found = {
        atsType: detected.atsType,
        atsIdentifier: detected.atsIdentifier ?? detected.atsType,
        careersUrl,
      };
      break;
    }
  }
  if (!found) {
    const probed = await resolveAtsForCompany(company, `https://${domain}`, { throttleMs: 100 });
    if (probed) {
      found = {
        atsType: probed.atsType,
        atsIdentifier: probed.atsIdentifier,
        careersUrl: `https://${domain}`,
      };
    }
  }
  boardConfigCache.set(key, found);
  return found;
}

async function boardJobsFor(config: BoardConfig): Promise<AtsJob[] | null> {
  const key = `${config.atsType}:${config.atsIdentifier}`;
  if (boardJobsCache.has(key)) return boardJobsCache.get(key)!;
  let jobs: AtsJob[] | null = null;
  try {
    const listed = await listJobsForCompany({
      name: config.atsIdentifier,
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
  boardJobsCache.set(key, jobs);
  return jobs;
}

type Result =
  | { state: "RESOLVED"; path: string; url: string; ms: number; hadJd: boolean }
  | { state: "CLOSED"; url: string }
  | { state: "UNRESOLVED"; reason: FreshSignalReason; detail: string };

async function resolveOne(signal: RawInternListJob): Promise<Result> {
  const started = Date.now();

  const direct = [signal.officialApplicationUrl, signal.originalJobPostUrl, signal.applyUrl].find(
    (value): value is string =>
      Boolean(value) && !isAggregatorUrl(value) && isValidOfficialApplicationUrl(value),
  );
  if (direct) {
    const probe = await probeOfficialJobAvailability(direct);
    if (probe.state === "closed") return { state: "CLOSED", url: direct };
    return { state: "RESOLVED", path: "direct", url: direct, ms: Date.now() - started, hadJd: false };
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

  const jobs = await boardJobsFor(config);
  if (jobs === null || jobs.length === 0) {
    return {
      state: "UNRESOLVED",
      reason: "ATS_BOARD_FETCH_FAILED",
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

  const probe = await probeOfficialJobAvailability(verdict.job.applyUrl);
  if (probe.state === "closed") return { state: "CLOSED", url: verdict.job.applyUrl };
  return {
    state: "RESOLVED",
    path: "employer_board",
    url: verdict.job.applyUrl,
    ms: Date.now() - started,
    hadJd: Boolean(verdict.job.description && verdict.job.description.length > 200),
  };
}

async function main() {
  const sampleSize = Number.parseInt(process.argv[2] ?? "40", 10) || 40;
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
  let resolved = 0;
  let closed = 0;
  let withJd = 0;
  const byPath: Record<string, number> = {};

  let cursor = 0;
  const workers = Array.from({ length: Math.min(6, sample.length) }, async () => {
    while (cursor < sample.length) {
      const index = cursor++;
      const signal = sample[index]!;
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
        if (result.hadJd) withJd += 1;
        console.log(`  OK   ${signal.company} — ${signal.title}\n       ${result.url}`);
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

  console.log("\n" + "=".repeat(60));
  console.log(`examined            ${sample.length}`);
  console.log(`officially resolved ${resolved} (${((resolved / sample.length) * 100).toFixed(1)}%)`);
  console.log(`  by path           ${JSON.stringify(byPath)}`);
  console.log(`  with a real JD    ${withJd}`);
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
