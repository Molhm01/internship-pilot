// Fresh engineering-internship radar.
//
// This is the pipeline that answers "what legitimate engineering internships
// were posted most recently, and can I apply through the real employer page
// right now?". Public feeds are DISCOVERY SIGNALS only — nothing they publish
// becomes an Apply destination. A signal becomes a visible job only after this
// module independently reaches the employer's own posting.
//
//   fresh signal
//     → normalize company / title / location
//     → official URL stated by the feed row?            (direct)
//     → official URL stated by the feed's detail page?  (source original post)
//     → otherwise resolve the employer's own board and match the posting
//     → verify the official destination is alive
//     → promote to Discover immediately (ATS scoring happens afterwards)
//
// Every signal that does not make it through carries a CONCRETE reason code and
// a retry schedule in FreshSignalResolution. There is no generic "unresolved".

import { prisma } from "@/lib/db";
import { listJobsForCompany } from "@/lib/ats";
import { fetchEightfoldJobDescription } from "@/lib/ats/eightfold";
import { fetchPhenomJobDescription } from "@/lib/ats/phenom";
import { resolveWithHeadlessBrowser } from "@/lib/ats/headlessResolver";
import { listEmployerPageJobs } from "@/lib/ats/employerPageLinks";
import type { AtsJob } from "@/lib/ats/types";
import {
  isAggregatorUrl,
  isValidOfficialApplicationUrl,
} from "@/lib/applications/officialDestination";
import { promoteCanonicalDirectJob } from "@/lib/jobs/activeFeed";
import { inferResolvedSource } from "@/lib/sync/discoveryResolution";
import {
  extractNextData,
  parseInternListPayload,
  type RawInternListJob,
} from "@/lib/sync/internListAdapter";
import { isTargetEngineeringRole } from "@/lib/sync/classify";
import { classifyOfficialBoardMatch } from "@/lib/sync/officialBoardMatch";
import { probeOfficialJobAvailability } from "@/lib/sync/freshness";
import { upsertClassifiedAtsJob } from "@/lib/sync/ingest";
import {
  countReason,
  emptyReasonCounts,
  formatReasonCounts,
  nextAttemptDelayMs,
  normalizeCompanyKey,
  isTransientReason,
  type FreshSignalReason,
  type FreshSignalReasonCounts,
} from "@/lib/sync/freshSignalReasons";
import {
  loadApprovedCompanyIndex,
  resolveEmployerBoard,
  type EmployerBoardConfig,
  type EmployerBoardOutcome,
} from "@/lib/sync/employerBoardResolution";
import {
  EMPTY_SIGNAL_DETAIL,
  fetchJobrightSignalDetail,
  type JobrightSignalDetail,
} from "@/lib/sync/jobrightSignalDetail";
import {
  employerAtsProvenance,
  parseFirstSourceDate,
  trustedRadarProvenance,
  type SourceDateProvenance,
} from "@/lib/sync/sourceDate";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const FRESH_SIGNAL_SOURCE = "jobright";

// Jobright's public internship hub is organized by taxonomy slug. Only these
// carry technical internship volume — probing on 2026-08-22 showed
// engineering_development at 5,384 open postings, data_engineer 144,
// data_science 131, product_management 198, and every other candidate slug
// ("software_engineer", "machine_learning_ai", "hardware_engineering",
// "devops", ...) returning zero. Invalid slugs answer HTTP 200 with an empty
// list rather than a 404, so a dead slug costs a request and yields nothing;
// the list below is the measured set that actually carries rows.
const CATEGORY_SLUGS = [
  "engineering_development",
  "data_engineer",
  "data_science",
] as const;

const FRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * ONE_DAY_MS;

/** Signals examined per tick. Sized for a ~5 minute cadence. */
const DEFAULT_LIMIT = 400;
const MAX_LIMIT = 1000;

const SIGNAL_CONCURRENCY = 12;

function categoryUrl(slug: string): string {
  return `https://jobright.ai/minisites-jobs/intern/us/${slug}?embed=true`;
}

function signalIdentity(job: RawInternListJob): string {
  return `${job.company}|${job.title}|${job.location ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

async function fetchCategory(slug: string, capturedAt: Date): Promise<RawInternListJob[]> {
  try {
    const response = await fetch(categoryUrl(slug), {
      headers: { "User-Agent": USER_AGENT },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return [];
    const nextData = extractNextData(await response.text());
    return nextData ? parseInternListPayload(nextData, capturedAt) : [];
  } catch {
    return [];
  }
}

export async function fetchJobrightFreshSignals(now = new Date()): Promise<{
  jobs: RawInternListJob[];
  categoryCounts: Record<string, number>;
  freshUnder24h: number;
  freshUnder72h: number;
}> {
  const batches = await Promise.all(
    CATEGORY_SLUGS.map(async (slug) => ({ slug, jobs: await fetchCategory(slug, now) })),
  );

  const categoryCounts: Record<string, number> = {};
  const seen = new Set<string>();
  const jobs: RawInternListJob[] = [];
  for (const batch of batches) {
    categoryCounts[batch.slug] = batch.jobs.length;
    for (const job of batch.jobs) {
      if (!job.sourcePostedAt) continue;
      const ageMs = now.getTime() - job.sourcePostedAt.getTime();
      if (ageMs < 0 || ageMs > FRESH_MAX_AGE_MS) continue;
      if (!isTargetEngineeringRole(job.title, job.qualifications)) continue;
      const key = signalIdentity(job);
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(job);
    }
  }

  jobs.sort(
    (a, b) =>
      (b.sourcePostedAt?.getTime() ?? 0) - (a.sourcePostedAt?.getTime() ?? 0) ||
      a.sourceRowIndex - b.sourceRowIndex,
  );

  return {
    jobs,
    categoryCounts,
    freshUnder24h: jobs.filter((job) => now.getTime() - job.sourcePostedAt!.getTime() <= ONE_DAY_MS).length,
    freshUnder72h: jobs.filter((job) => now.getTime() - job.sourcePostedAt!.getTime() <= THREE_DAYS_MS).length,
  };
}

/**
 * Build the record we persist for a resolved signal.
 *
 * The description ALWAYS comes from the employer's own board posting. A feed's
 * qualification bullets are its own summary of the job, not the employer's job
 * description, and writing them into `description` would make a synthesized JD
 * indistinguishable from a real one to the ATS scorer. When the board gave no
 * body text the field stays empty and JD hydration fills it later — the job is
 * still promoted immediately, marked as scoring-pending.
 */
export function asOfficialAtsJob(
  signal: RawInternListJob,
  applyUrl: string,
  boardJob?: AtsJob | null,
): AtsJob {
  return {
    sourceJobId: boardJob?.sourceJobId ?? `jobright-fresh:${signal.sourceJobId}`,
    requisitionId: boardJob?.requisitionId ?? null,
    title: boardJob?.title ?? signal.title,
    company: signal.company,
    location: boardJob?.location ?? signal.location,
    workplaceType: boardJob?.workplaceType ?? signal.workModel,
    applyUrl,
    description: boardJob?.description ?? "",
    // Employer/ATS freshness outranks radar freshness. The radar timestamp is
    // only the fallback when the official posting supplies no date.
    postedAt: boardJob?.postedAt ?? signal.sourcePostedAt ?? null,
    postedAtText: boardJob?.postedAtText ?? signal.sourcePostedText ?? null,
  };
}

async function persistOfficialSignal(
  job: AtsJob,
  providerHint?: string | null,
  sourceDateProvenance?: SourceDateProvenance,
): Promise<{
  outcome: "new" | "updated" | "unchanged";
  jobId: string | null;
  provider: string;
}> {
  const resolved = inferResolvedSource(job.applyUrl, providerHint);
  const outcome = await upsertClassifiedAtsJob({
    job,
    source: resolved.source,
    atsType: resolved.atsType,
    atsTenant: resolved.atsTenant,
    classification: "QUALIFYING_INTERNSHIP",
    classificationReason:
      "Fresh public internship signal independently resolved to an original employer/ATS posting.",
    now: new Date(),
    sourceDateProvenance,
  });
  await promoteCanonicalDirectJob(job, resolved.source, resolved.atsTenant);

  const stored = await prisma.job.findFirst({
    where: { officialApplicationUrl: job.applyUrl },
    select: { id: true },
  });
  return { outcome, jobId: stored?.id ?? null, provider: resolved.source };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type FreshRadarDiagnostics = {
  categoriesAttempted: number;
  categoryCounts: Record<string, number>;
  /** Fresh, engineering-filtered, de-duplicated signals the source offered. */
  signalsFetched: number;
  under24h: number;
  under72h: number;
  /** Signals actually put through resolution this tick. */
  examined: number;
  /** Skipped because a previous tick already resolved them. */
  alreadyResolved: number;
  /** Signal matched a canonical official job before any employer crawl. */
  alreadyFoundOfficial: number;
  /** Skipped because their retry backoff has not elapsed. */
  deferred: number;
  officialUrlDirect: number;
  sourceOriginalPost: number;
  /** Employers resolved to a board automatically (i.e. not from the CSV). */
  companyResolved: number;
  boardResolved: number;
  unresolved: number;
  closed: number;
  /** Resolved signals that collapsed onto a Job that already existed. */
  duplicates: number;
  newJobs: number;
  updatedJobs: number;
  medianResolutionMs: number | null;
  reasonCounts: FreshSignalReasonCounts;
  /** Resolved postings by the official system they were resolved through. */
  providerCounts: Record<string, number>;
  /** Resolved postings that already carry the employer's real job description. */
  resolvedWithJd: number;
};

/** One-line render used by the scheduler log and the diagnostic script. */
export function formatFreshRadarDiagnostics(d: FreshRadarDiagnostics): string {
  const resolved = d.alreadyFoundOfficial + d.officialUrlDirect + d.sourceOriginalPost + d.boardResolved;
  const rate = d.examined > 0 ? Math.round((resolved / d.examined) * 100) : 0;
  return (
    `signals=${d.signalsFetched} <24h=${d.under24h} <72h=${d.under72h} ` +
    `examined=${d.examined} alreadyOfficial=${d.alreadyFoundOfficial} direct=${d.officialUrlDirect} original=${d.sourceOriginalPost} ` +
    `boardResolved=${d.boardResolved} companyResolved=${d.companyResolved} ` +
    `resolved=${resolved} (${rate}%) unresolved=${d.unresolved} closed=${d.closed} ` +
    `duplicates=${d.duplicates} new=${d.newJobs} updated=${d.updatedJobs} ` +
    `alreadyResolved=${d.alreadyResolved} deferred=${d.deferred} ` +
    `withJD=${d.resolvedWithJd}/${resolved} ` +
    `medianResolutionMs=${d.medianResolutionMs ?? "n/a"} | providers: ${formatProviderCounts(d.providerCounts)}` +
    ` | reasons: ${formatReasonCounts(d.reasonCounts)}`
  );
}

/** "greenhouse=4 workday=3" — busiest provider first. */
export function formatProviderCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, value]) => value > 0);
  if (entries.length === 0) return "none";
  return entries
    .sort(([leftKey, left], [rightKey, right]) => right - left || leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

type SignalOutcome =
  | {
      state: "RESOLVED";
      path: "already_official" | "direct_official_url" | "source_original_post" | "employer_board";
      url: string;
      jobId: string | null;
      persistOutcome: "new" | "updated" | "unchanged";
      /** True when the employer's board was found automatically, not from the CSV. */
      autoResolvedEmployer: boolean;
      /** Canonical provider token the destination was attributed to. */
      provider: string;
      /** True when a real employer job description came with the resolution. */
      hasEmployerJd: boolean;
    }
  | { state: "CLOSED"; url: string; reason: string }
  | { state: "PENDING"; reason: FreshSignalReason; detail: string };

/**
 * Verify a candidate official destination, then persist it.
 *
 * A transient network failure is never read as a closure: probeOfficialJobAvailability
 * answers "unknown" for anything that is not an explicit 404/410 or an explicit
 * closed-posting statement, and "unknown" is treated as still open. A posting
 * that later really is gone is caught by the freshness verification batch,
 * which re-checks live jobs on its own schedule.
 */
export function shouldPromoteAfterProbe(state: "open" | "closed" | "unknown"): boolean {
  // "unknown" means the check itself failed (timeout, 5xx, blocked bot check),
  // which says nothing about the posting. Treating it as a closure would delete
  // real internships from the feed every time a board had a bad minute.
  return state !== "closed";
}

/** The candidate destinations a feed row can offer, strongest first. */
export function directOfficialUrlFrom(signal: {
  officialApplicationUrl?: string | null;
  originalJobPostUrl?: string | null;
  applyUrl?: string | null;
}): string | null {
  return (
    [signal.officialApplicationUrl, signal.originalJobPostUrl, signal.applyUrl].find(
      (value): value is string =>
        Boolean(value) && !isAggregatorUrl(value) && isValidOfficialApplicationUrl(value),
    ) ?? null
  );
}

async function verifyAndPersist(
  signal: RawInternListJob,
  url: string,
  boardJob: AtsJob | null,
  path: "direct_official_url" | "source_original_post" | "employer_board",
  autoResolvedEmployer: boolean,
  providerHint?: string | null,
): Promise<SignalOutcome> {
  const probe = await probeOfficialJobAvailability(url);
  if (!shouldPromoteAfterProbe(probe.state)) {
    return { state: "CLOSED", url, reason: probe.reason };
  }

  try {
    const job = asOfficialAtsJob(signal, url, boardJob);
    const capturedAt = new Date();
    const parsedDate = parseFirstSourceDate([job.postedAt, job.postedAtText], capturedAt);
    const officialSuppliedDate = Boolean(boardJob?.postedAt || boardJob?.postedAtText);
    const dateProvenance = officialSuppliedDate
      ? employerAtsProvenance(parsedDate)
      : trustedRadarProvenance(parsedDate);
    const { outcome, jobId, provider } = await persistOfficialSignal(job, providerHint, dateProvenance);
    return {
      state: "RESOLVED",
      path,
      url,
      jobId,
      persistOutcome: outcome,
      autoResolvedEmployer,
      provider,
      hasEmployerJd: job.description.trim().length > 200,
    };
  } catch (error) {
    return {
      state: "PENDING",
      reason: "PARSER_FAILURE",
      detail: `Persisting the resolved posting failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Board contents, fetched at most once per employer per tick. */
type BoardCache = Map<string, { jobs: AtsJob[]; fetchFailed: boolean; botWalled: boolean }>;

/**
 * In-flight employer resolutions, keyed by normalized company.
 *
 * The database cache alone is not enough: a single sweep frequently carries a
 * dozen postings from the same employer, and with concurrent workers they all
 * start resolving before any of them has written a cache row. Sharing the
 * PROMISE means one careers-page crawl per employer per tick instead of one
 * per posting.
 */
type EmployerResolutionCache = Map<string, Promise<EmployerBoardOutcome>>;

export type OfficialCatalogEntry = AtsJob & {
  jobId: string;
  provider: string;
  hasEmployerJd: boolean;
};
export type OfficialCatalogIndex = Map<string, OfficialCatalogEntry[]>;

/** Match against canonical official jobs before spending a network request. */
export function findExistingOfficialMatch(
  signal: Pick<RawInternListJob, "company" | "title" | "location">,
  index: OfficialCatalogIndex,
): OfficialCatalogEntry | null {
  const candidates = index.get(normalizeCompanyKey(signal.company)) ?? [];
  if (candidates.length === 0) return null;
  const verdict = classifyOfficialBoardMatch(
    { title: signal.title, location: signal.location },
    candidates,
  );
  if (!verdict.accepted) return null;
  return candidates.find((candidate) => candidate.applyUrl === verdict.job.applyUrl) ?? null;
}

export function officialSearchDecision(
  signal: Pick<RawInternListJob, "company" | "title" | "location">,
  index: OfficialCatalogIndex,
): { action: "attach_existing"; job: OfficialCatalogEntry } | { action: "priority_crawl" } {
  const job = findExistingOfficialMatch(signal, index);
  return job ? { action: "attach_existing", job } : { action: "priority_crawl" };
}

async function loadOfficialCatalogIndex(): Promise<OfficialCatalogIndex> {
  const jobs = await prisma.job.findMany({
    where: {
      activeFeed: true,
      verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
      officialApplicationUrl: { not: null },
    },
    select: {
      id: true,
      source: true,
      sourceJobId: true,
      requisitionId: true,
      title: true,
      company: true,
      location: true,
      workplaceType: true,
      officialApplicationUrl: true,
      description: true,
      sourcePostedAt: true,
      sourcePostedText: true,
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

/**
 * Vendors that answer automated HTTP reads with a bot wall rather than their
 * public listing. An empty result from one of these is a blocked read, not an
 * employer with no openings, and it is worth one bounded rendered page.
 */
const BOT_WALLED_VENDORS = new Set(["icims", "taleo", "custom", "spa", "employer-page"]);

async function boardJobsFor(
  config: EmployerBoardConfig,
  companyName: string,
  cache: BoardCache,
): Promise<{ jobs: AtsJob[]; fetchFailed: boolean; botWalled: boolean }> {
  const key = `${config.atsType}:${config.atsIdentifier}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let result: { jobs: AtsJob[]; fetchFailed: boolean; botWalled: boolean };
  try {
    const listed = await listJobsForCompany({
      ...config,
      lastETag: null,
      lastModified: null,
      contentHash: null,
    });
    result = listed.supported
      ? { jobs: listed.jobs, fetchFailed: false, botWalled: false }
      : { jobs: [], fetchFailed: true, botWalled: false };
  } catch {
    result = { jobs: [], fetchFailed: true, botWalled: false };
  }

  // Before spending a browser: the employer's OWN careers page often links
  // directly to every posting on the walled board, in plain server-rendered
  // HTML. One cheap fetch, and it frequently succeeds where the vendor's portal
  // refuses to answer at all.
  if (result.jobs.length === 0 && config.careersUrl) {
    const linked = await listEmployerPageJobs(config.careersUrl, companyName);
    if (linked.length > 0) result = { jobs: linked, fetchFailed: false, botWalled: false };
  }

  // Bounded headless fallback. Reached ONLY after the HTTP/API path produced
  // nothing, only for vendors known to gate automated reads, and only through
  // ordinary public navigation. resolveWithHeadlessBrowser owns the process
  // limits: one browser at a time, closed at the end of the batch.
  if (result.jobs.length === 0 && BOT_WALLED_VENDORS.has(config.atsType ?? "")) {
    const renderUrl = headlessListingUrlFor(config);
    if (renderUrl) {
      const [outcome] = await resolveWithHeadlessBrowser([
        { tenantKey: key, url: renderUrl, companyName },
      ]);
      if (outcome && outcome.jobs.length > 0) {
        result = { jobs: outcome.jobs, fetchFailed: false, botWalled: false };
      } else {
        result = { jobs: [], fetchFailed: true, botWalled: true };
      }
    } else {
      result = { ...result, botWalled: true };
    }
  }

  cache.set(key, result);
  return result;
}

/**
 * Attach the employer's real job description to a matched board posting.
 *
 * Adapters for the client-rendered vendors deliberately list without
 * descriptions — one detail request per listed posting would be dozens of
 * requests per employer for a single match. Fetching exactly one, here, keeps
 * the cost proportional while still giving the ATS scorer real text.
 *
 * A failure is not an error: the posting is promoted regardless and the
 * asynchronous JD hydration pass fills the gap later.
 */
async function withEmployerDescription(
  config: EmployerBoardConfig,
  job: AtsJob,
): Promise<AtsJob> {
  if (job.description && job.description.trim().length > 200) return job;
  if (!config.atsIdentifier) return job;

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

/** The public listing page worth rendering for a vendor that blocked us. */
function headlessListingUrlFor(config: EmployerBoardConfig): string | null {
  if (config.atsType === "icims" && config.atsIdentifier) {
    return `https://${config.atsIdentifier}.icims.com/jobs/search?ss=1&searchKeyword=intern`;
  }
  return config.careersUrl ?? null;
}

async function resolveOneSignal(
  signal: RawInternListJob,
  officialCatalog: OfficialCatalogIndex,
  approvedIndex: Awaited<ReturnType<typeof loadApprovedCompanyIndex>>,
  boardCache: BoardCache,
  employerCache: EmployerResolutionCache,
  now: Date,
): Promise<SignalOutcome> {
  if (!signal.company.trim() || !signal.title.trim()) {
    return { state: "PENDING", reason: "PARSER_FAILURE", detail: "Signal had no usable company/title." };
  }

  const decision = officialSearchDecision(signal, officialCatalog);
  if (decision.action === "attach_existing") {
    const existingOfficial = decision.job;
    return {
      state: "RESOLVED",
      path: "already_official",
      url: existingOfficial.applyUrl,
      jobId: existingOfficial.jobId,
      persistOutcome: "unchanged",
      autoResolvedEmployer: false,
      provider: existingOfficial.provider,
      hasEmployerJd: existingOfficial.hasEmployerJd,
    };
  }

  // 1. An official destination the feed row states outright.
  const direct = directOfficialUrlFrom(signal);
  if (direct) {
    return verifyAndPersist(signal, direct, null, "direct_official_url", false);
  }

  // 2. Enrichment: the feed's per-job page may state the employer destination,
  //    and reliably states the employer's own website.
  let detail: JobrightSignalDetail = EMPTY_SIGNAL_DETAIL;
  if (signal.sourceJobId && !signal.sourceJobId.startsWith("intern-list-public:")) {
    detail = await fetchJobrightSignalDetail(signal.sourceJobId);
  }

  if (detail.removedAtSource) {
    return { state: "PENDING", reason: "POSTING_CLOSED", detail: "The discovery source marks this posting as removed." };
  }

  if (detail.originalJobPostUrl) {
    return verifyAndPersist(signal, detail.originalJobPostUrl, null, "source_original_post", false);
  }

  // 3. Resolve the employer's own board — including employers that are not in
  //    the approved-employer CSV.
  const employerKey = normalizeCompanyKey(signal.company);
  let pending = employerCache.get(employerKey);
  if (!pending) {
    pending = resolveEmployerBoard(signal.company, detail.companyDomain, approvedIndex, now);
    employerCache.set(employerKey, pending);
  }
  const board = await pending;
  if (!board.ok) {
    return {
      state: "PENDING",
      reason: board.reason,
      detail:
        board.reason === "UNKNOWN_COMPANY"
          ? `No approved company row and no source-published website for "${signal.company}".`
          : `No official job board could be established for "${signal.company}".`,
    };
  }

  const { jobs, fetchFailed, botWalled } = await boardJobsFor(
    board.config,
    signal.company,
    boardCache,
  );
  // An empty result is reported as a FETCH failure, not as "the board has
  // nothing like this". Vendors such as iCIMS answer automated reads with a
  // bot wall (HTTP 405 "Human Verification"), which is indistinguishable from
  // an employer with zero openings — and the two want opposite handling. Erring
  // towards "retry soon" keeps a real internship in the queue instead of
  // classifying it as a settled miss and backing off for a day.
  if (fetchFailed || jobs.length === 0) {
    return {
      state: "PENDING",
      reason: botWalled ? "BOT_WALL_BLOCKED" : "ATS_BOARD_FETCH_FAILED",
      detail: `Read no postings from ${board.config.atsType}/${board.config.atsIdentifier} for "${signal.company}".`,
    };
  }

  const verdict = classifyOfficialBoardMatch(
    { title: signal.title, location: signal.location },
    jobs,
  );
  if (!verdict.accepted) {
    return {
      state: "PENDING",
      reason: verdict.reason,
      detail:
        `Best score ${verdict.bestScore.toFixed(2)}, closest title similarity ` +
        `${verdict.bestTitleSimilarity.toFixed(2)} ("${verdict.closestTitle ?? "none"}") across ` +
        `${jobs.length} posting(s) on ${board.config.atsType}/${board.config.atsIdentifier}.`,
    };
  }

  // Final destination gate. scoreOfficialBoardMatch only rejects aggregator
  // hosts; a generic/low-confidence adapter can still hand back a careers
  // landing page or a search URL, and neither is something to send an applicant
  // to as "the official posting".
  if (!isValidOfficialApplicationUrl(verdict.job.applyUrl)) {
    return {
      state: "PENDING",
      reason: "OFFICIAL_URL_REJECTED",
      detail: `Board match resolved to a non-job destination: ${verdict.job.applyUrl}`,
    };
  }

  // The matched posting is the ONLY one whose description is worth fetching, so
  // it is fetched here rather than by the adapter listing dozens of them. This
  // is what turns "resolved but unscoreable" into "resolved with a real JD".
  const boardJob = await withEmployerDescription(board.config, verdict.job);

  return verifyAndPersist(
    signal,
    boardJob.applyUrl,
    boardJob,
    "employer_board",
    board.config.origin !== "approved_company",
    board.config.atsType,
  );
}

// ---------------------------------------------------------------------------
// Retry-queue bookkeeping
// ---------------------------------------------------------------------------

type QueueRow = {
  id: string;
  state: string;
  attempts: number;
  nextAttemptAt: Date | null;
};

export type FreshSignalWorkflowState =
  | "SIGNAL_SEEN"
  | "OFFICIAL_SEARCH_QUEUED"
  | "OFFICIAL_SEARCHING"
  | "OFFICIAL_RESOLVED"
  | "NO_MATCH_YET"
  | "TRANSIENT_FAILURE"
  | "PERMANENT_FAILURE";

export function finalWorkflowState(
  state: "RESOLVED" | "CLOSED" | "PENDING",
  reason?: FreshSignalReason,
): FreshSignalWorkflowState {
  if (state === "RESOLVED") return "OFFICIAL_RESOLVED";
  if (state === "CLOSED") return "PERMANENT_FAILURE";
  return reason && isTransientReason(reason) ? "TRANSIENT_FAILURE" : "NO_MATCH_YET";
}

async function loadQueueRows(signalJobIds: string[]): Promise<Map<string, QueueRow>> {
  if (signalJobIds.length === 0) return new Map();
  const rows = await prisma.freshSignalResolution.findMany({
    where: { signalSource: FRESH_SIGNAL_SOURCE, signalJobId: { in: signalJobIds } },
    select: { id: true, signalJobId: true, state: true, attempts: true, nextAttemptAt: true },
  });
  return new Map(rows.map((row) => [row.signalJobId, row]));
}

async function persistQueuedSignals(
  signals: RawInternListJob[],
  existing: Map<string, QueueRow>,
  now: Date,
): Promise<void> {
  const unseen = signals.filter((signal) => !existing.has(signal.sourceJobId));
  if (unseen.length > 0) {
    await prisma.freshSignalResolution.createMany({
      data: unseen.map((signal) => ({
        signalSource: FRESH_SIGNAL_SOURCE,
        signalJobId: signal.sourceJobId,
        company: signal.company,
        normalizedCompany: normalizeCompanyKey(signal.company),
        title: signal.title,
        location: signal.location,
        sourcePostedAt: signal.sourcePostedAt,
        sourceCapturedAt: now,
        state: "PENDING",
        workflowState: "SIGNAL_SEEN",
      })),
      skipDuplicates: true,
    });
  }
  await prisma.freshSignalResolution.updateMany({
    where: {
      signalSource: FRESH_SIGNAL_SOURCE,
      signalJobId: { in: signals.map((signal) => signal.sourceJobId) },
      state: { not: "RESOLVED" },
    },
    data: { workflowState: "OFFICIAL_SEARCH_QUEUED" },
  });
}

async function recordSignalOutcome(args: {
  signal: RawInternListJob;
  outcome: SignalOutcome;
  attempts: number;
  now: Date;
  elapsedMs: number;
}): Promise<void> {
  const { signal, outcome, attempts, now } = args;
  const identity = {
    company: signal.company,
    normalizedCompany: normalizeCompanyKey(signal.company),
    title: signal.title,
    location: signal.location,
    sourcePostedAt: signal.sourcePostedAt,
    sourceCapturedAt: now,
    attempts,
    lastAttemptAt: now,
  };

  const specific =
    outcome.state === "RESOLVED"
      ? {
          state: "RESOLVED",
          workflowState: finalWorkflowState("RESOLVED"),
          reasonCode: null,
          reasonDetail: null,
          resolutionPath: outcome.path,
          resolvedUrl: outcome.url,
          resolvedJobId: outcome.jobId,
          resolutionMs: args.elapsedMs,
          nextAttemptAt: null,
        }
      : outcome.state === "CLOSED"
        ? {
            state: "CLOSED",
            workflowState: finalWorkflowState("CLOSED"),
            reasonCode: "POSTING_CLOSED" satisfies FreshSignalReason,
            reasonDetail: outcome.reason,
            resolutionPath: null,
            resolvedUrl: outcome.url,
            resolvedJobId: null,
            resolutionMs: null,
            nextAttemptAt: null,
          }
        : {
            state: "PENDING",
            workflowState: finalWorkflowState("PENDING", outcome.reason),
            reasonCode: outcome.reason,
            reasonDetail: outcome.detail,
            resolutionPath: null,
            resolvedUrl: null,
            resolvedJobId: null,
            resolutionMs: null,
            nextAttemptAt: new Date(now.getTime() + nextAttemptDelayMs(outcome.reason, attempts)),
          };

  await prisma.freshSignalResolution.upsert({
    where: {
      signalSource_signalJobId: {
        signalSource: FRESH_SIGNAL_SOURCE,
        signalJobId: signal.sourceJobId,
      },
    },
    create: {
      signalSource: FRESH_SIGNAL_SOURCE,
      signalJobId: signal.sourceJobId,
      ...identity,
      ...specific,
    },
    update: { ...identity, ...specific },
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runJobrightFreshDiscovery(
  limit = DEFAULT_LIMIT,
): Promise<FreshRadarDiagnostics> {
  const boundedLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
  const now = new Date();
  const source = await fetchJobrightFreshSignals(now);
  const selected = source.jobs.slice(0, boundedLimit);

  const approvedIndex = await loadApprovedCompanyIndex();
  const officialCatalog = await loadOfficialCatalogIndex();
  const queueRows = await loadQueueRows(selected.map((signal) => signal.sourceJobId));
  await persistQueuedSignals(selected, queueRows, now);
  const boardCache: BoardCache = new Map();
  const employerCache: EmployerResolutionCache = new Map();
  const reasonCounts = emptyReasonCounts();
  const resolutionTimes: number[] = [];

  const diagnostics: FreshRadarDiagnostics = {
    categoriesAttempted: CATEGORY_SLUGS.length,
    categoryCounts: source.categoryCounts,
    signalsFetched: source.jobs.length,
    under24h: source.freshUnder24h,
    under72h: source.freshUnder72h,
    examined: 0,
    alreadyResolved: 0,
    alreadyFoundOfficial: 0,
    deferred: 0,
    officialUrlDirect: 0,
    sourceOriginalPost: 0,
    companyResolved: 0,
    boardResolved: 0,
    unresolved: 0,
    closed: 0,
    duplicates: 0,
    newJobs: 0,
    updatedJobs: 0,
    medianResolutionMs: null,
    reasonCounts,
    providerCounts: {},
    resolvedWithJd: 0,
  };

  let cursor = 0;
  const workers = Array.from({ length: Math.min(SIGNAL_CONCURRENCY, selected.length) }, async () => {
    while (cursor < selected.length) {
      const signal = selected[cursor++]!;
      const queued = queueRows.get(signal.sourceJobId);

      if (queued?.state === "RESOLVED") {
        diagnostics.alreadyResolved += 1;
        continue;
      }
      // Honour the retry backoff. A signal is never dropped — only postponed.
      if (queued?.nextAttemptAt && queued.nextAttemptAt > now) {
        diagnostics.deferred += 1;
        continue;
      }

      const attempts = (queued?.attempts ?? 0) + 1;
      await prisma.freshSignalResolution.updateMany({
        where: { signalSource: FRESH_SIGNAL_SOURCE, signalJobId: signal.sourceJobId },
        data: { workflowState: "OFFICIAL_SEARCHING" },
      });
      const startedAt = Date.now();
      let outcome: SignalOutcome;
      try {
        outcome = await resolveOneSignal(signal, officialCatalog, approvedIndex, boardCache, employerCache, now);
      } catch (error) {
        outcome = {
          state: "PENDING",
          reason: "NETWORK_FAILURE",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      const elapsedMs = Date.now() - startedAt;

      diagnostics.examined += 1;
      if (outcome.state === "RESOLVED") {
        resolutionTimes.push(elapsedMs);
        if (outcome.path === "already_official") diagnostics.alreadyFoundOfficial += 1;
        else if (outcome.path === "direct_official_url") diagnostics.officialUrlDirect += 1;
        else if (outcome.path === "source_original_post") diagnostics.sourceOriginalPost += 1;
        else diagnostics.boardResolved += 1;
        if (outcome.autoResolvedEmployer) diagnostics.companyResolved += 1;
        if (outcome.hasEmployerJd) diagnostics.resolvedWithJd += 1;
        diagnostics.providerCounts[outcome.provider] =
          (diagnostics.providerCounts[outcome.provider] ?? 0) + 1;
        if (outcome.persistOutcome === "new") diagnostics.newJobs += 1;
        else if (outcome.persistOutcome === "updated") {
          diagnostics.updatedJobs += 1;
          diagnostics.duplicates += 1;
        } else diagnostics.duplicates += 1;
      } else if (outcome.state === "CLOSED") {
        diagnostics.closed += 1;
        countReason(reasonCounts, "POSTING_CLOSED");
      } else {
        diagnostics.unresolved += 1;
        countReason(reasonCounts, outcome.reason);
      }

      try {
        await recordSignalOutcome({ signal, outcome, attempts, now, elapsedMs });
      } catch (error) {
        // Bookkeeping must never lose a job that was already promoted.
        console.error("[fresh-radar] could not record signal outcome", {
          signalJobId: signal.sourceJobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  await Promise.all(workers);

  diagnostics.medianResolutionMs = median(resolutionTimes);
  return diagnostics;
}
