import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { isAggregatorUrl } from "@/lib/applications/officialDestination";
import { hasUsableJobDescription } from "@/lib/matchWorkflow";
import { fetchWorkdayJobDetail } from "@/lib/ats/workday";
import { parseStructuredJobPage } from "@/lib/ats/structuredCareer";
import {
  employerAtsProvenance,
  parseFirstSourceDate,
  shouldReplaceCanonicalSourceDate,
  type ParsedSourceDate,
  type SourceDateProvenance,
} from "@/lib/sync/sourceDate";

const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 2_000_000;
const RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// A job with a usable description AND a known source-posted date needs no
// further hydration, ever — but "never again" isn't expressible as NULL
// (NULL means "never evaluated, due now" — see the schema comment on
// Job.descriptionHydrationNextAttemptAt). A date far beyond any real posting
// window is the sentinel instead, so the WHERE clause's `<= now` never
// matches it without needing a third NULL-vs-"done" state to track.
const HYDRATION_DONE_SENTINEL = new Date("9999-01-01T00:00:00.000Z");
const USER_AGENT =
  "Mozilla/5.0 (compatible; InternshipPilot/1.0; +https://github.com/Molhm01/internship-pilot)";

const JOB_TEXT_SIGNAL =
  /\b(responsibilit(?:y|ies)|qualifications?|requirements?|experience|skills?|duties|about the role|what you(?:'|’)ll do|what you bring|job description)\b/i;

export type DescriptionHydrationResult = {
  considered: number;
  attempted: number;
  hydrated: number;
  datesHydrated: number;
  failed: number;
  skippedCooldown: number;
};

export type HydrationJob = {
  id: string;
  title: string;
  company: string;
  description: string;
  jobResponsibilities: string | null;
  jobQualifications: string | null;
  officialJobUrl: string | null;
  originalJobPostUrl: string | null;
  officialApplicationUrl: string | null;
  officialApplyUrl: string | null;
  url: string | null;
  resolutionStatus: string;
  verificationStatus: string;
  atsType: string | null;
  atsTenant: string | null;
  sourceJobId: string | null;
  scoringError: string | null;
  scoringQueuedAt: Date | null;
  sourcePostedAt: Date | null;
  sourcePostedText: string | null;
  sourceDateConfidence: string | null;
  sourceDateProvenance: string | null;
  firstSeenAt: Date | null;
};

export type OfficialHydrationEvidence = {
  description: string | null;
  sourceDate: ParsedSourceDate;
  sourceDateProvenance: SourceDateProvenance;
};

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function visibleText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(p|div|li|section|article|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function privateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = host.match(/^172\.(\d+)\./);
  if (match) {
    const second = Number(match[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return host === "0.0.0.0" || host === "::1";
}

function usableOfficialUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || privateHostname(url.hostname) || isAggregatorUrl(url.toString())) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .match(/[a-z0-9+#.]{3,}/g)
    ?.filter((token) => !["intern", "internship", "summer", "engineer", "engineering"].includes(token))
    .slice(0, 6) ?? [];
}

function looksLikeJobPosting(text: string, job: Pick<HydrationJob, "title" | "company">): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length < 180) return false;
  if (JOB_TEXT_SIGNAL.test(normalized)) return true;
  const lower = normalized.toLowerCase();
  const tokens = titleTokens(job.title);
  const titleHits = tokens.filter((token) => lower.includes(token)).length;
  return titleHits >= Math.min(2, Math.max(1, tokens.length))
    && lower.includes(job.company.toLowerCase().split(/\s+/)[0] ?? "");
}

async function fetchPage(url: string): Promise<{ raw: string; text: string } | null> {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "user-agent": USER_AGENT,
    },
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const raw = (await response.text()).slice(0, MAX_HTML_BYTES);
  const contentType = response.headers.get("content-type") ?? "";
  if (/json/i.test(contentType)) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      const text = JSON.stringify(parsed);
      return { raw, text };
    } catch {
      return { raw, text: raw };
    }
  }
  return { raw, text: visibleText(raw) };
}

async function greenhouseDescription(job: HydrationJob): Promise<string | null> {
  if (!job.atsTenant || !job.sourceJobId || !/^\d+$/.test(job.sourceJobId)) return null;
  const response = await fetch(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(job.atsTenant)}/jobs/${encodeURIComponent(job.sourceJobId)}`,
    { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" },
  );
  if (!response.ok) return null;
  const data = await response.json() as { content?: string };
  return data.content ? visibleText(data.content) : null;
}

function leverParts(rawUrl: string): { tenant: string; postingId: string } | null {
  try {
    const url = new URL(rawUrl);
    if (!/(^|\.)jobs(?:\.eu)?\.lever\.co$/i.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { tenant: parts[0], postingId: parts[1] };
  } catch {
    return null;
  }
}

async function leverEvidence(rawUrl: string, capturedAt: Date): Promise<OfficialHydrationEvidence | null> {
  const parts = leverParts(rawUrl);
  if (!parts) return null;
  const response = await fetch(
    `https://api.lever.co/v0/postings/${encodeURIComponent(parts.tenant)}/${encodeURIComponent(parts.postingId)}`,
    { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" },
  );
  if (!response.ok) return null;
  const posting = await response.json() as {
    descriptionPlain?: string;
    openingPlain?: string;
    descriptionBodyPlain?: string;
    additionalPlain?: string;
    lists?: Array<{ text?: string; content?: string }>;
    createdAt?: number | string;
  };
  const description = [
    posting.openingPlain,
    posting.descriptionPlain,
    posting.descriptionBodyPlain,
    ...(posting.lists ?? []).map((section) => `${section.text ?? ""}\n${visibleText(section.content ?? "")}`),
    posting.additionalPlain,
  ].filter(Boolean).join("\n\n").trim() || null;
  const sourceDate = parseFirstSourceDate([posting.createdAt], capturedAt);
  return { description, sourceDate, sourceDateProvenance: employerAtsProvenance(sourceDate) };
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Ashby's own posting id, read out of an `https://jobs.ashbyhq.com/{board}/{id}`
 * URL. A job discovered through a third-party aggregator (Simplify, Jobright,
 * "zapply:"/"dreamwork:" boards, ...) stores THAT aggregator's id in
 * sourceJobId, which never matches an Ashby posting id — the aggregator id is
 * a different identifier scheme, not a broken/stale Ashby id. Ashby's own id
 * is a UUID and it is always present in the canonical job/apply URL, so it is
 * extracted from there instead of trusted from sourceJobId.
 */
export function ashbyPostingIdFromUrl(url: string | null | undefined): string | null {
  return url?.match(UUID_PATTERN)?.[0]?.toLowerCase() ?? null;
}

async function ashbyEvidence(job: HydrationJob, officialUrl: string, capturedAt: Date): Promise<OfficialHydrationEvidence | null> {
  const urlPostingId = ashbyPostingIdFromUrl(officialUrl) ?? ashbyPostingIdFromUrl(job.url);
  const candidateId = urlPostingId ?? job.sourceJobId;
  if (!job.atsTenant || !candidateId) return null;
  const response = await fetch(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(job.atsTenant)}`,
    { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" },
  );
  if (!response.ok) return null;
  const data = await response.json() as { jobs?: Array<{ id?: string; descriptionPlain?: string; publishedAt?: string }> };
  const posting = data.jobs?.find((item) => item.id?.toLowerCase() === candidateId.toLowerCase());
  if (!posting) return null;
  const sourceDate = parseFirstSourceDate([posting.publishedAt], capturedAt);
  return {
    description: posting.descriptionPlain?.trim() || null,
    sourceDate,
    sourceDateProvenance: employerAtsProvenance(sourceDate),
  };
}

async function smartRecruitersEvidence(job: HydrationJob, capturedAt: Date): Promise<OfficialHydrationEvidence | null> {
  if (!job.atsTenant || !job.sourceJobId) return null;
  const response = await fetch(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(job.atsTenant)}/postings/${encodeURIComponent(job.sourceJobId)}`,
    { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" },
  );
  if (!response.ok) return null;
  const data = await response.json() as {
    jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
    releasedDate?: string;
  };
  const sections = Object.values(data.jobAd?.sections ?? {});
  const description = sections
    .map((section) => `${section.title ?? ""}\n${visibleText(section.text ?? "")}`.trim())
    .filter(Boolean)
    .join("\n\n") || null;
  const sourceDate = parseFirstSourceDate([data.releasedDate], capturedAt);
  return { description, sourceDate, sourceDateProvenance: employerAtsProvenance(sourceDate) };
}

function noSourceDate(): ParsedSourceDate {
  return { sourcePostedAt: null, sourcePostedText: null, sourceDateConfidence: "UNKNOWN" };
}

async function fetchBestEvidence(
  job: HydrationJob,
  officialUrl: string,
  capturedAt: Date,
): Promise<OfficialHydrationEvidence> {
  const ats = job.atsType?.toLowerCase() ?? "";
  let specific: OfficialHydrationEvidence | null = null;
  if (ats === "workday" && job.atsTenant && job.sourceJobId) {
    const detail = await fetchWorkdayJobDetail(job.atsTenant, officialUrl, job.sourceJobId);
    if (detail) {
      const sourceDate = parseFirstSourceDate([detail.postedAt, detail.postedAtText], capturedAt);
      specific = {
        description: detail.description || null,
        sourceDate,
        sourceDateProvenance: employerAtsProvenance(sourceDate),
      };
    }
  } else if (ats === "greenhouse") {
    specific = { description: await greenhouseDescription(job), sourceDate: noSourceDate(), sourceDateProvenance: "UNKNOWN" };
  } else if (ats === "lever") {
    specific = await leverEvidence(officialUrl, capturedAt);
  } else if (ats === "ashby") {
    specific = await ashbyEvidence(job, officialUrl, capturedAt);
  } else if (ats === "smartrecruiters") {
    specific = await smartRecruitersEvidence(job, capturedAt);
  } else {
    specific = await leverEvidence(officialUrl, capturedAt);
  }

  if (specific && ((specific.description && looksLikeJobPosting(specific.description, job)) || specific.sourceDate.sourcePostedAt)) {
    if (specific.description && !looksLikeJobPosting(specific.description, job)) specific.description = null;
    return specific;
  }

  const page = await fetchPage(officialUrl);
  if (!page) return { description: null, sourceDate: noSourceDate(), sourceDateProvenance: "UNKNOWN" };
  const structured = parseStructuredJobPage(page.raw, officialUrl, job.company, job.title);
  const description = structured?.description && looksLikeJobPosting(structured.description, job)
    ? structured.description
    : looksLikeJobPosting(page.text, job) ? page.text : null;
  const sourceDate = parseFirstSourceDate([structured?.postedAt], capturedAt);
  return {
    description,
    sourceDate,
    sourceDateProvenance: sourceDate.sourcePostedAt ? "EMPLOYER_JSON_LD" : "UNKNOWN",
  };
}

// The old scoringError-based cooldown check (recentlyFailed) is superseded
// by descriptionHydrationNextAttemptAt, which the bounded query in
// hydrateMissingDescriptionsForScoring now filters on directly.

type HydrationOutcome = { descriptionHydrated: boolean; dateHydrated: boolean; failed: boolean };

export function hydrationPriority(job: Pick<HydrationJob, "description" | "jobResponsibilities" | "jobQualifications" | "sourcePostedAt" | "firstSeenAt">, now: Date): number {
  const missingDescription = !hasUsableJobDescription(job);
  const postedAge = job.sourcePostedAt ? now.getTime() - job.sourcePostedAt.getTime() : null;
  const discoveredAge = job.firstSeenAt ? now.getTime() - job.firstSeenAt.getTime() : null;
  const knownFresh = postedAge !== null && postedAge >= 0 && postedAge <= 7 * 24 * 60 * 60 * 1000;
  const unknownNew = !job.sourcePostedAt && discoveredAge !== null && discoveredAge >= 0 && discoveredAge <= 72 * 60 * 60 * 1000;
  if (missingDescription && knownFresh) return 0;
  if (missingDescription && unknownNew) return 1;
  if (unknownNew) return 2;
  if (missingDescription) return 3;
  if (!job.sourcePostedAt) return 4;
  return 5;
}

export async function applyOfficialHydrationEvidence(
  job: HydrationJob,
  officialUrl: string,
  evidence: OfficialHydrationEvidence,
  now: Date,
): Promise<HydrationOutcome> {
  const description = evidence.description;
  const descriptionHydrated = Boolean(
    description
    && hasUsableJobDescription(description)
    && description.trim() !== job.description.trim(),
  );
  const dateHydrated = shouldReplaceCanonicalSourceDate(
    job,
    evidence.sourceDate,
    evidence.sourceDateProvenance,
  );
  if (!descriptionHydrated && !dateHydrated) {
    // Nothing usable came back — record backoff so this job doesn't stay
    // "due now" and re-enter the bounded candidate query on every future
    // run until something actually changes at the source.
    await prisma.job.update({
      where: { id: job.id },
      data: { descriptionHydrationNextAttemptAt: new Date(now.getTime() + RETRY_COOLDOWN_MS) },
    }).catch(() => undefined);
    return { descriptionHydrated: false, dateHydrated: false, failed: true };
  }

  // Whether this job will still need another hydration pass after this
  // write: done once it has BOTH a usable description and a known
  // source-posted date. Computed from the post-write state, not just what
  // this call changed, so a job that already had one of the two before this
  // call correctly resolves to "done" rather than lingering forever.
  const willHaveDescription = descriptionHydrated || hasUsableJobDescription(job);
  const willHaveDate = dateHydrated ? Boolean(evidence.sourceDate.sourcePostedAt) : Boolean(job.sourcePostedAt);
  const nextAttempt = willHaveDescription && willHaveDate
    ? HYDRATION_DONE_SENTINEL
    : new Date(now.getTime() + RETRY_COOLDOWN_MS);

  await prisma.job.update({
    where: { id: job.id },
    data: {
      ...(descriptionHydrated && description ? {
        description,
        jobDescriptionSourceUrl: officialUrl,
        jobDescriptionCapturedAt: now,
        jobDescriptionHash: createHash("sha256").update(description).digest("hex"),
        scoringState: "NOT_SCORED",
        scoringError: null,
        scoringQueuedAt: null,
      } : {}),
      ...(dateHydrated ? {
        sourcePostedAt: evidence.sourceDate.sourcePostedAt,
        postingDate: evidence.sourceDate.sourcePostedAt,
        sourcePostedText: evidence.sourceDate.sourcePostedText,
        sourceDateConfidence: evidence.sourceDate.sourceDateConfidence,
        sourceDateProvenance: evidence.sourceDateProvenance,
      } : {}),
      descriptionHydrationNextAttemptAt: nextAttempt,
    },
  });

  if (descriptionHydrated) {
    const { baselineScoreJobForAllEligibleUsers } = await import("@/lib/matching/baselineScoring");
    const { scheduleInitialAiMatchForAllUsers } = await import("@/lib/matching/initialAiMatchQueue");
    await baselineScoreJobForAllEligibleUsers(job.id);
    await scheduleInitialAiMatchForAllUsers(job.id, { startWorker: false });
  }
  return { descriptionHydrated, dateHydrated, failed: false };
}

async function hydrateOne(job: HydrationJob, now: Date): Promise<HydrationOutcome> {
  const officialUrl = [
    job.officialJobUrl,
    job.originalJobPostUrl,
    job.officialApplicationUrl,
    job.officialApplyUrl,
    job.url,
  ].map(usableOfficialUrl).find(Boolean) ?? null;

  // Backoff is recorded regardless of whether this job already has a usable
  // description — a job with a description but no source-posted date (or no
  // resolvable official URL yet) must not stay "due now" forever under the
  // new bounded query, or it would re-enter every hydration run without ever
  // being able to make progress.
  const backoffAt = new Date(now.getTime() + RETRY_COOLDOWN_MS);

  if (!officialUrl || (job.resolutionStatus !== "RESOLVED" && job.verificationStatus !== "VERIFIED_OFFICIAL_AT_LAST_CHECK")) {
    await prisma.job.update({
      where: { id: job.id },
      data: {
        ...(!hasUsableJobDescription(job) ? {
          scoringState: "DESCRIPTION_PENDING",
          scoringError: "DESCRIPTION_OFFICIAL_URL_UNAVAILABLE",
          scoringQueuedAt: now,
        } : {}),
        descriptionHydrationNextAttemptAt: backoffAt,
      },
    }).catch(() => undefined);
    return { descriptionHydrated: false, dateHydrated: false, failed: true };
  }

  try {
    const evidence = await fetchBestEvidence(job, officialUrl, now);
    const outcome = await applyOfficialHydrationEvidence(job, officialUrl, evidence, now);

    if (outcome.failed) {
      // applyOfficialHydrationEvidence already recorded backoff on this
      // exact failure path (see its own `if (!descriptionHydrated &&
      // !dateHydrated)` branch) — only the scoringState bookkeeping below is
      // still this function's responsibility.
      if (!hasUsableJobDescription(job)) {
        await prisma.job.update({
          where: { id: job.id },
          data: {
            scoringState: "DESCRIPTION_PENDING",
            scoringError: "DESCRIPTION_FETCH_INSUFFICIENT",
            scoringQueuedAt: now,
          },
        }).catch(() => undefined);
      }
      return { descriptionHydrated: false, dateHydrated: false, failed: true };
    }

    return outcome;
  } catch (error) {
    console.warn("[description-hydration] official job description fetch failed", {
      jobId: job.id,
      errorCode: error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : error instanceof Error ? error.name : "DESCRIPTION_FETCH_FAILED",
      error: error instanceof Error ? error.message.slice(0, 300) : "DESCRIPTION_FETCH_FAILED",
    });
    await prisma.job.update({
      where: { id: job.id },
      data: {
        descriptionHydrationNextAttemptAt: backoffAt,
        ...(!hasUsableJobDescription(job) ? {
          scoringState: "DESCRIPTION_PENDING",
          scoringError: "DESCRIPTION_FETCH_FAILED",
          scoringQueuedAt: now,
        } : {}),
      },
    }).catch(() => undefined);
    return { descriptionHydrated: false, dateHydrated: false, failed: true };
  }
}

/**
 * Bounded, cloud-safe description enrichment that runs before each hosted ATS
 * scoring sweep. It never scores from a title alone: jobs without enough text
 * stay in DESCRIPTION_PENDING until an official employer/ATS page can supply a
 * real job description.
 */
export async function hydrateMissingDescriptionsForScoring(options: {
  maxItems?: number;
  concurrency?: number;
} = {}): Promise<DescriptionHydrationResult> {
  const maxItems = Math.max(1, Math.min(40, Math.trunc(options.maxItems ?? 16)));
  const concurrency = Math.max(1, Math.min(6, Math.trunc(options.concurrency ?? 4)));
  const now = new Date();

  // Bounded, indexed candidate query (database-usage repair, pass #4) — this
  // used to read every activeFeed job and filter in JS. Every job's
  // eligibility is now tracked explicitly in
  // descriptionHydrationNextAttemptAt (NULL = never evaluated, due now; a
  // past/present timestamp = due again after backoff; a far-future sentinel
  // = already has a usable description and a known date, done). The WHERE
  // clause does the filtering an in-memory `.filter()` used to, against a
  // small `take`, not the whole table. `recentlyFailed`'s old scoringError-
  // based cooldown check is superseded by this field and no longer needed —
  // a row this query returns is, by construction, actually due.
  const active = await prisma.job.findMany({
    where: {
      activeFeed: true,
      OR: [
        { descriptionHydrationNextAttemptAt: null },
        { descriptionHydrationNextAttemptAt: { lte: now } },
      ],
    },
    orderBy: [{ firstSeenAt: "desc" }, { id: "desc" }],
    // A few times maxItems, not just maxItems: hydrationPriority still needs
    // a small pool to pick the best candidates from (freshest/most-missing
    // first), not merely the first N rows in firstSeenAt order.
    take: maxItems * 5,
    select: {
      id: true,
      title: true,
      company: true,
      description: true,
      jobResponsibilities: true,
      jobQualifications: true,
      officialJobUrl: true,
      originalJobPostUrl: true,
      officialApplicationUrl: true,
      officialApplyUrl: true,
      url: true,
      resolutionStatus: true,
      verificationStatus: true,
      atsType: true,
      atsTenant: true,
      sourceJobId: true,
      scoringError: true,
      scoringQueuedAt: true,
      sourcePostedAt: true,
      sourcePostedText: true,
      sourceDateConfidence: true,
      sourceDateProvenance: true,
      firstSeenAt: true,
    },
  });

  // Defensive double-check, not a full-table scan: `active` is already
  // bounded by the query above. This only matters for a NULL (never
  // evaluated) row that turns out to already be complete — a state a
  // properly-maintained field should never produce, but a cheap in-memory
  // check against an already-small set costs nothing to keep as a guard.
  const missing = active
    .filter((job) => !hasUsableJobDescription(job) || !job.sourcePostedAt)
    .sort((a, b) => hydrationPriority(a, now) - hydrationPriority(b, now)
      || (b.firstSeenAt?.getTime() ?? 0) - (a.firstSeenAt?.getTime() ?? 0)
      || b.id.localeCompare(a.id));
  const candidates = missing.slice(0, maxItems);
  const skippedCooldown = 0;

  let nextIndex = 0;
  let hydrated = 0;
  let datesHydrated = 0;
  let failed = 0;
  const worker = async () => {
    while (nextIndex < candidates.length) {
      const index = nextIndex;
      nextIndex += 1;
      const outcome = await hydrateOne(candidates[index], now);
      if (outcome.descriptionHydrated) hydrated += 1;
      if (outcome.dateHydrated) datesHydrated += 1;
      if (outcome.failed) failed += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length || 1) }, () => worker()));

  return {
    considered: missing.length,
    attempted: candidates.length,
    hydrated,
    datesHydrated,
    failed,
    skippedCooldown,
  };
}

const HYDRATION_JOB_SELECT = {
  id: true,
  title: true,
  company: true,
  description: true,
  jobResponsibilities: true,
  jobQualifications: true,
  officialJobUrl: true,
  originalJobPostUrl: true,
  officialApplicationUrl: true,
  officialApplyUrl: true,
  url: true,
  resolutionStatus: true,
  verificationStatus: true,
  atsType: true,
  atsTenant: true,
  sourceJobId: true,
  scoringError: true,
  scoringQueuedAt: true,
  sourcePostedAt: true,
  sourcePostedText: true,
  sourceDateConfidence: true,
  sourceDateProvenance: true,
  firstSeenAt: true,
} as const;

/**
 * A single job's bounded priority JD hydration — the "user just clicked
 * Apply" path, distinct from the bulk sweep above.
 *
 * Bounded by the same per-request FETCH_TIMEOUT_MS every evidence fetcher in
 * this file already uses; a slow or unreachable official source fails this
 * call quickly rather than making the applicant wait indefinitely. On any
 * failure (fetch error, no evidence, still thin) this returns `hydrated:
 * false` and does NOT throw — the caller's existing MASTER_RESUME_FALLBACK
 * path is the correct, already-safe response to "no usable JD was found,"
 * not an exception.
 */
/**
 * `preloadedJob` lets a caller that already holds the row (enqueueApplication
 * loads the full Job before deciding document strategy) skip the read below —
 * every field this function needs is already a plain scalar on that row, so
 * there is nothing left to fetch. Any subset of `HydrationJob`'s fields not
 * already on the caller's object still forces the normal read.
 */
export async function hydrateJobDescriptionForApply(
  jobId: string,
  preloadedJob?: HydrationJob,
): Promise<{ hydrated: boolean }> {
  const job = preloadedJob ?? await prisma.job.findUnique({ where: { id: jobId }, select: HYDRATION_JOB_SELECT });
  if (!job) return { hydrated: false };
  if (hasUsableJobDescription(job)) return { hydrated: false };
  try {
    const outcome = await hydrateOne(job, new Date());
    return { hydrated: outcome.descriptionHydrated };
  } catch {
    return { hydrated: false };
  }
}
