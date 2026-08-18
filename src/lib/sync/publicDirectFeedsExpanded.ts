import type { AtsJob } from "@/lib/ats/types";
import {
  isAggregatorUrl,
  isValidOfficialApplicationUrl,
} from "@/lib/applications/officialDestination";
import { promoteCanonicalDirectJob } from "@/lib/jobs/activeFeed";
import { isTargetEngineeringRole } from "@/lib/sync/classify";
import { inferResolvedSource } from "@/lib/sync/discoveryResolution";
import { canonicalizeJobUrl, upsertClassifiedAtsJob } from "@/lib/sync/ingest";
import { parseFirstSourceDate } from "@/lib/sync/sourceDate";
import { prisma } from "@/lib/db";

const USER_AGENT = "Mozilla/5.0 Internship-Pilot/1.0";
const APPLY_GUY_FEED =
  "https://raw.githubusercontent.com/ApplyGuy/2027-Internships/main/data/internships.json";
const DREAMWORK_FEED =
  "https://raw.githubusercontent.com/dreamworkhq/Open-Tech-Internships-2027/main/data/listings.json";

const EXTRA_ATS_HOSTS = [
  /(^|\.)workforcenow\.adp\.com$/,
  /(^|\.)workable\.com$/,
  /(^|\.)jobvite\.com$/,
  /(^|\.)dayforcehcm\.com$/,
  /(^|\.)paylocity\.com$/,
  /(^|\.)paycomonline\.net$/,
  /(^|\.)ultipro\.com$/,
  /(^|\.)ukg\.(com|net)$/,
  /(^|\.)bamboohr\.com$/,
  /(^|\.)eightfold\.ai$/,
  /(^|\.)avature\.net$/,
  /(^|\.)brassring\.com$/,
  /(^|\.)csod\.com$/,
  /(^|\.)cornerstoneondemand\.com$/,
] as const;

const JOB_QUERY_KEYS = /^(job|jobid|job_id|jobreqid|job_req_id|req|reqid|req_id|requisition|requisitionid|requisition_id|career_job_req_id|opportunityid|opportunity_id|postingid|posting_id|positionid|position_id)$/i;

export type ExpandedDirectCandidate = {
  discoverySource: "applyguy" | "dreamwork";
  sourceJobId: string;
  title: string;
  company: string;
  location: string | null;
  workplaceType: string | null;
  postedAt: Date | null;
  postedAtText: string | null;
  internshipTerm: string | null;
  officialUrl: string;
};

type ApplyGuyPayload = {
  jobs?: Array<{
    id?: unknown;
    company?: unknown;
    title?: unknown;
    category?: unknown;
    location?: unknown;
    season?: unknown;
    posted?: unknown;
    listingUrl?: unknown;
  }>;
};

type DreamworkPayload = {
  listings?: Array<{
    id?: unknown;
    title?: unknown;
    company?: unknown;
    location?: unknown;
    remoteType?: unknown;
    postedAt?: unknown;
    url?: unknown;
  }>;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function normalizeWorkplace(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized.includes("remote")) return "Remote";
  if (normalized.includes("hybrid")) return "Hybrid";
  if (normalized.includes("onsite") || normalized.includes("on-site") || normalized.includes("on site")) {
    return "On Site";
  }
  return value;
}

/**
 * Public direct feeds already give us the employer/ATS URL. We still require a
 * job-specific HTTPS destination and reject every known aggregator. The old
 * validator covered our first-party ATS adapters but was intentionally narrow;
 * this adds common public ATS URL shapes without accepting generic careers
 * landing pages.
 */
export function isJobSpecificOfficialUrl(value: string | null | undefined): value is string {
  if (!value || isAggregatorUrl(value)) return false;
  if (isValidOfficialApplicationUrl(value)) return true;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.toLowerCase().replace(/\/+$/, "");
  const queryHasJobId = [...url.searchParams.entries()].some(
    ([key, candidate]) => JOB_QUERY_KEYS.test(key) && candidate.trim().length > 0,
  );

  const explicitJobPath =
    /\/(jobs?|positions?|openings?|opportunities?|vacancies?)\/[^/]+/i.test(path) ||
    /\/candidateexperience\/[^?]*\/job\/[^/]+/i.test(path) ||
    /\/careers?\/[^?]*\/job\/[^/]+/i.test(path) ||
    /\/recruit(?:ing|ment)?\/[^?]*\/jobs?\/[^/]+/i.test(path);

  const knownAts = EXTRA_ATS_HOSTS.some((pattern) => pattern.test(host));
  return explicitJobPath || (knownAts && queryHasJobId);
}

function parseApplyGuy(payload: ApplyGuyPayload, capturedAt: Date): ExpandedDirectCandidate[] {
  const result: ExpandedDirectCandidate[] = [];
  for (const raw of Array.isArray(payload.jobs) ? payload.jobs : []) {
    const id = text(raw.id);
    const company = text(raw.company);
    const title = text(raw.title);
    const category = text(raw.category) ?? "";
    const officialUrl = text(raw.listingUrl);
    if (!id || !company || !title || !isJobSpecificOfficialUrl(officialUrl)) continue;
    if (!isTargetEngineeringRole(title, category)) continue;

    const sourceDate = parseFirstSourceDate([raw.posted], capturedAt);
    const season = text(raw.season);
    result.push({
      discoverySource: "applyguy",
      sourceJobId: `applyguy:${id}`,
      title,
      company,
      location: text(raw.location),
      workplaceType: null,
      postedAt: sourceDate.sourcePostedAt,
      postedAtText: sourceDate.sourcePostedText,
      internshipTerm: season && season.toLowerCase() !== "not specified" ? season : null,
      officialUrl,
    });
  }
  return result;
}

function parseDreamwork(payload: DreamworkPayload, capturedAt: Date): ExpandedDirectCandidate[] {
  const result: ExpandedDirectCandidate[] = [];
  for (const raw of Array.isArray(payload.listings) ? payload.listings : []) {
    const id = text(raw.id);
    const company = text(raw.company);
    const title = text(raw.title);
    const officialUrl = text(raw.url);
    if (!id || !company || !title || !isJobSpecificOfficialUrl(officialUrl)) continue;
    if (!isTargetEngineeringRole(title, "")) continue;

    const sourceDate = parseFirstSourceDate([raw.postedAt], capturedAt);
    result.push({
      discoverySource: "dreamwork",
      sourceJobId: `dreamwork:${id}`,
      title,
      company,
      location: text(raw.location),
      workplaceType: normalizeWorkplace(text(raw.remoteType)),
      postedAt: sourceDate.sourcePostedAt,
      postedAtText: sourceDate.sourcePostedText,
      internshipTerm: null,
      officialUrl,
    });
  }
  return result;
}

function identity(candidate: ExpandedDirectCandidate): string {
  return canonicalizeJobUrl(candidate.officialUrl)
    ?? `${candidate.company}|${candidate.title}|${candidate.location ?? ""}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .trim();
}

export async function fetchExpandedDirectCandidates(): Promise<{
  candidates: ExpandedDirectCandidate[];
  applyGuyFetched: number;
  dreamworkFetched: number;
}> {
  const capturedAt = new Date();
  const [applyGuyPayload, dreamworkPayload] = await Promise.all([
    fetchJson<ApplyGuyPayload>(APPLY_GUY_FEED),
    fetchJson<DreamworkPayload>(DREAMWORK_FEED),
  ]);

  const applyGuy = applyGuyPayload ? parseApplyGuy(applyGuyPayload, capturedAt) : [];
  const dreamwork = dreamworkPayload ? parseDreamwork(dreamworkPayload, capturedAt) : [];
  const seen = new Set<string>();
  const candidates: ExpandedDirectCandidate[] = [];

  for (const candidate of [...applyGuy, ...dreamwork].sort(
    (a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0),
  )) {
    const key = identity(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }

  return {
    candidates,
    applyGuyFetched: applyGuy.length,
    dreamworkFetched: dreamwork.length,
  };
}

/**
 * High-throughput ingestion for current public indexes that already expose the
 * original employer/ATS job URL.
 *
 * The previous implementation re-fetched every official ATS URL and discarded
 * anything whose ATS blocked Vercel with 403/429/challenge responses. That made
 * a valid current Workday/Oracle/etc. posting disappear merely because its ATS
 * disliked server-side probes. Here the current feed sighting + job-specific
 * official URL is the admission evidence. Confirmed closures are still handled
 * continuously by the separate freshness verifier and future source removal.
 */
export async function runExpandedPublicDirectFeedDiscovery(
  limit = 600,
): Promise<{
  sourceFetched: number;
  applyGuyFetched: number;
  dreamworkFetched: number;
  alreadyActive: number;
  examined: number;
  newCount: number;
  updatedCount: number;
  unchangedCount: number;
}> {
  const boundedLimit = Math.max(1, Math.min(limit, 600));
  const source = await fetchExpandedDirectCandidates();

  const activeRows = await prisma.job.findMany({
    where: { activeFeed: true, officialApplicationUrl: { not: null } },
    select: { officialApplicationUrl: true },
  });
  const activeUrls = new Set(
    activeRows
      .map((row) => canonicalizeJobUrl(row.officialApplicationUrl))
      .filter((value): value is string => Boolean(value)),
  );

  const unseen = source.candidates.filter((candidate) => {
    const canonical = canonicalizeJobUrl(candidate.officialUrl);
    return !canonical || !activeUrls.has(canonical);
  });
  const selected = unseen.slice(0, boundedLimit);

  let cursor = 0;
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  const workers = Array.from({ length: Math.min(16, selected.length) }, async () => {
    while (cursor < selected.length) {
      const candidate = selected[cursor++]!;
      const resolved = inferResolvedSource(candidate.officialUrl);
      const job: AtsJob = {
        sourceJobId: candidate.sourceJobId,
        requisitionId: null,
        title: candidate.title,
        company: candidate.company,
        location: candidate.location,
        workplaceType: candidate.workplaceType,
        applyUrl: candidate.officialUrl,
        description: "",
        postedAt: candidate.postedAt,
        postedAtText: candidate.postedAtText,
      };

      const outcome = await upsertClassifiedAtsJob({
        job,
        source: resolved.source,
        atsType: resolved.atsType,
        atsTenant: resolved.atsTenant,
        classification: "QUALIFYING_INTERNSHIP",
        classificationReason:
          `Discovered in the current ${candidate.discoverySource} public internship index with a job-specific original employer/ATS URL.`,
        now: new Date(),
      });
      await promoteCanonicalDirectJob(job, resolved.source, resolved.atsTenant);

      if (outcome === "new") newCount += 1;
      else if (outcome === "updated") updatedCount += 1;
      else unchangedCount += 1;
    }
  });
  await Promise.all(workers);

  return {
    sourceFetched: source.candidates.length,
    applyGuyFetched: source.applyGuyFetched,
    dreamworkFetched: source.dreamworkFetched,
    alreadyActive: source.candidates.length - unseen.length,
    examined: selected.length,
    newCount,
    updatedCount,
    unchangedCount,
  };
}
