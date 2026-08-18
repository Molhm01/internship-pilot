import type { AtsJob } from "@/lib/ats/types";
import {
  isAggregatorUrl,
  isValidOfficialApplicationUrl,
} from "@/lib/applications/officialDestination";
import { promoteCanonicalDirectJob } from "@/lib/jobs/activeFeed";
import { isTargetEngineeringRole } from "@/lib/sync/classify";
import { inferResolvedSource } from "@/lib/sync/discoveryResolution";
import { probeOfficialJobAvailability } from "@/lib/sync/freshness";
import { canonicalizeJobUrl, upsertClassifiedAtsJob } from "@/lib/sync/ingest";
import { parseFirstSourceDate } from "@/lib/sync/sourceDate";
import { prisma } from "@/lib/db";

const USER_AGENT = "Mozilla/5.0 Internship-Pilot/1.0";

const APPLY_GUY_FEED =
  "https://raw.githubusercontent.com/ApplyGuy/2027-Internships/main/data/internships.json";
const DREAMWORK_FEED =
  "https://raw.githubusercontent.com/dreamworkhq/Open-Tech-Internships-2027/main/data/listings.json";

export type PublicDirectCandidate = {
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
  updatedAt?: string;
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
  generatedAt?: string;
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
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
  const text = value.toLowerCase();
  if (text.includes("remote")) return "Remote";
  if (text.includes("hybrid")) return "Hybrid";
  if (text.includes("onsite") || text.includes("on-site") || text.includes("on site")) {
    return "On Site";
  }
  return value;
}

function validOfficialUrl(value: string | null): value is string {
  return Boolean(value) && !isAggregatorUrl(value) && isValidOfficialApplicationUrl(value);
}

export function parseApplyGuyFeed(
  payload: ApplyGuyPayload,
  capturedAt: Date = new Date(),
): PublicDirectCandidate[] {
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  const result: PublicDirectCandidate[] = [];

  for (const raw of jobs) {
    const id = nonEmptyString(raw.id);
    const company = nonEmptyString(raw.company);
    const title = nonEmptyString(raw.title);
    const location = nonEmptyString(raw.location);
    const season = nonEmptyString(raw.season);
    const officialUrl = nonEmptyString(raw.listingUrl);
    if (!id || !company || !title || !validOfficialUrl(officialUrl)) continue;
    if (!isTargetEngineeringRole(title, nonEmptyString(raw.category) ?? "")) continue;

    const sourceDate = parseFirstSourceDate([raw.posted], capturedAt);
    result.push({
      discoverySource: "applyguy",
      sourceJobId: `applyguy:${id}`,
      title,
      company,
      location,
      workplaceType: null,
      postedAt: sourceDate.sourcePostedAt,
      postedAtText: sourceDate.sourcePostedText,
      internshipTerm: season && season.toLowerCase() !== "not specified" ? season : null,
      officialUrl,
    });
  }

  return result;
}

export function parseDreamworkFeed(
  payload: DreamworkPayload,
  capturedAt: Date = new Date(),
): PublicDirectCandidate[] {
  const jobs = Array.isArray(payload.listings) ? payload.listings : [];
  const result: PublicDirectCandidate[] = [];

  for (const raw of jobs) {
    const id = nonEmptyString(raw.id);
    const company = nonEmptyString(raw.company);
    const title = nonEmptyString(raw.title);
    const location = nonEmptyString(raw.location);
    const officialUrl = nonEmptyString(raw.url);
    if (!id || !company || !title || !validOfficialUrl(officialUrl)) continue;
    if (!isTargetEngineeringRole(title, "")) continue;

    const sourceDate = parseFirstSourceDate([raw.postedAt], capturedAt);
    result.push({
      discoverySource: "dreamwork",
      sourceJobId: `dreamwork:${id}`,
      title,
      company,
      location,
      workplaceType: normalizeWorkplace(nonEmptyString(raw.remoteType)),
      postedAt: sourceDate.sourcePostedAt,
      postedAtText: sourceDate.sourcePostedText,
      internshipTerm: null,
      officialUrl,
    });
  }

  return result;
}

function canonicalIdentity(candidate: PublicDirectCandidate): string {
  return canonicalizeJobUrl(candidate.officialUrl)
    ?? `${candidate.company}|${candidate.title}|${candidate.location ?? ""}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .trim();
}

function newestFirst(left: PublicDirectCandidate, right: PublicDirectCandidate): number {
  return (right.postedAt?.getTime() ?? 0) - (left.postedAt?.getTime() ?? 0);
}

function selectCandidates(
  candidates: PublicDirectCandidate[],
  limit: number,
  now = new Date(),
): PublicDirectCandidate[] {
  if (candidates.length <= limit) return candidates;

  const newestBudget = Math.min(limit, Math.max(40, Math.ceil(limit * 0.6)));
  const newest = candidates.slice(0, newestBudget);
  const rotatingBudget = limit - newestBudget;
  if (rotatingBudget <= 0) return newest;

  const tail = candidates.slice(newestBudget);
  if (tail.length <= rotatingBudget) return [...newest, ...tail];
  const bucket = Math.floor(now.getTime() / (30 * 60 * 1000));
  const offset = (bucket * rotatingBudget) % tail.length;
  const rotating: PublicDirectCandidate[] = [];
  for (let i = 0; i < rotatingBudget; i += 1) {
    rotating.push(tail[(offset + i) % tail.length]!);
  }
  return [...newest, ...rotating];
}

export async function fetchPublicDirectCandidates(): Promise<{
  candidates: PublicDirectCandidate[];
  applyGuyFetched: number;
  dreamworkFetched: number;
}> {
  const capturedAt = new Date();
  const [applyGuyPayload, dreamworkPayload] = await Promise.all([
    fetchJson<ApplyGuyPayload>(APPLY_GUY_FEED),
    fetchJson<DreamworkPayload>(DREAMWORK_FEED),
  ]);

  const applyGuy = applyGuyPayload ? parseApplyGuyFeed(applyGuyPayload, capturedAt) : [];
  const dreamwork = dreamworkPayload ? parseDreamworkFeed(dreamworkPayload, capturedAt) : [];

  const seen = new Set<string>();
  const candidates: PublicDirectCandidate[] = [];
  for (const candidate of [...applyGuy, ...dreamwork].sort(newestFirst)) {
    const key = canonicalIdentity(candidate);
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

export async function runPublicDirectFeedDiscovery(
  limit = 160,
): Promise<{
  sourceFetched: number;
  applyGuyFetched: number;
  dreamworkFetched: number;
  alreadyActive: number;
  examined: number;
  open: number;
  closed: number;
  unknown: number;
  newCount: number;
  updatedCount: number;
}> {
  const boundedLimit = Math.max(1, Math.min(limit, 250));
  const source = await fetchPublicDirectCandidates();

  // Do not spend HTTP probes on postings that are already in the active feed.
  // Freshness verification handles those separately.
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
  const selected = selectCandidates(unseen, boundedLimit);

  let cursor = 0;
  let open = 0;
  let closed = 0;
  let unknown = 0;
  let newCount = 0;
  let updatedCount = 0;

  const workers = Array.from({ length: Math.min(12, selected.length) }, async () => {
    while (cursor < selected.length) {
      const candidate = selected[cursor++]!;
      const availability = await probeOfficialJobAvailability(candidate.officialUrl);
      if (availability.state === "closed") {
        closed += 1;
        continue;
      }
      if (availability.state !== "open") {
        unknown += 1;
        continue;
      }
      open += 1;

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
          `Discovered through ${candidate.discoverySource} public direct-job data and independently verified on the original employer/ATS posting.`,
        now: new Date(),
      });
      await promoteCanonicalDirectJob(job, resolved.source, resolved.atsTenant);

      if (outcome === "new") newCount += 1;
      else if (outcome === "updated") updatedCount += 1;
    }
  });
  await Promise.all(workers);

  return {
    sourceFetched: source.candidates.length,
    applyGuyFetched: source.applyGuyFetched,
    dreamworkFetched: source.dreamworkFetched,
    alreadyActive: source.candidates.length - unseen.length,
    examined: selected.length,
    open,
    closed,
    unknown,
    newCount,
    updatedCount,
  };
}
