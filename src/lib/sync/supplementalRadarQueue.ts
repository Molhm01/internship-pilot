import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { listJobsForCompany, type CompanyForListing } from "@/lib/ats";
import type { AtsJob } from "@/lib/ats/types";
import {
  isAggregatorUrl,
  isValidOfficialApplicationUrl,
  resolveOfficialJobDestination,
} from "@/lib/applications/officialDestination";
import { promoteCanonicalDirectJob } from "@/lib/jobs/activeFeed";
import { inferResolvedSource } from "@/lib/sync/discoveryResolution";
import { fetchInternListPublicRadar } from "@/lib/sync/internListPublicRadar";
import { scoreOfficialBoardMatch } from "@/lib/sync/officialBoardMatch";
import { upsertClassifiedAtsJob } from "@/lib/sync/ingest";

const EVENT_PREFIX = "supplementalRadar:event:";
const INTERN_LIST_CURSOR_KEY = "supplementalRadar:cursor:intern-list-public";
const MAX_EVENT_ROWS = 10_000;

type QueueState = "pending" | "retry" | "resolved" | "closed" | "abandoned";

export type SupplementalRadarSource =
  | "intern-list-public"
  | "gmail-linkedin"
  | "gmail-handshake"
  | "gmail-indeed"
  | "gmail-glassdoor"
  | "gmail-ziprecruiter";

export type SupplementalRadarSignal = {
  source: SupplementalRadarSource;
  sourceJobId: string;
  title: string;
  company: string;
  location: string | null;
  sourceUrl: string | null;
  sourcePostedAt: Date | null;
  sourcePostedText: string | null;
};

type SerializedSignal = Omit<SupplementalRadarSignal, "sourcePostedAt"> & {
  sourcePostedAt: string | null;
};

type QueueRecord = {
  version: 1;
  state: QueueState;
  signal: SerializedSignal;
  attempts: number;
  firstQueuedAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string;
  resolvedAt: string | null;
  resolvedJobId: string | null;
  lastError: string | null;
};

type InternListCursor = {
  version: 1;
  source: "intern-list-public";
  lastCheckedAt: string;
  jobsSeen: number;
  pagesFetched: number;
  pagesFailed: number;
  maxPagesReached: boolean;
  maxJobsReached: boolean;
};

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function serializeSignal(signal: SupplementalRadarSignal): SerializedSignal {
  return {
    ...signal,
    sourcePostedAt: signal.sourcePostedAt?.toISOString() ?? null,
  };
}

function deserializeSignal(signal: SerializedSignal): SupplementalRadarSignal {
  return {
    ...signal,
    sourcePostedAt: signal.sourcePostedAt ? new Date(signal.sourcePostedAt) : null,
  };
}

function eventKey(signal: Pick<SupplementalRadarSignal, "source" | "sourceJobId">): string {
  const digest = createHash("sha256")
    .update(`${signal.source}|${signal.sourceJobId}`)
    .digest("hex")
    .slice(0, 40);
  return `${EVENT_PREFIX}${digest}`;
}

function companyKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|company|co|holdings|group)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function findCompanyConfig(
  companyName: string,
  companies: CompanyForListing[],
  exactMap: Map<string, CompanyForListing>,
): CompanyForListing | null {
  const key = companyKey(companyName);
  const exact = exactMap.get(key);
  if (exact) return exact;
  if (key.length < 5) return null;
  return (
    companies.find((company) => {
      const candidate = companyKey(company.name);
      return candidate.length >= 5 && (candidate.includes(key) || key.includes(candidate));
    }) ?? null
  );
}

function maxAgeMs(source: SupplementalRadarSource): number {
  return source === "intern-list-public"
    ? 120 * 24 * 60 * 60 * 1000
    : 21 * 24 * 60 * 60 * 1000;
}

function maxAttempts(source: SupplementalRadarSource): number {
  return source === "intern-list-public" ? 20 : 12;
}

function nextRetryAt(attempts: number): Date {
  const minutes = Math.min(12 * 60, 15 * 2 ** Math.min(attempts, 6));
  return new Date(Date.now() + minutes * 60 * 1000);
}

function isInternListSourcePage(value: string | null): value is string {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return host === "intern-list.com" || host === "jobright.ai";
  } catch {
    return false;
  }
}

function asAtsJob(
  signal: SupplementalRadarSignal,
  applyUrl: string,
  boardJob?: AtsJob | null,
): AtsJob {
  return {
    sourceJobId: boardJob?.sourceJobId ?? `${signal.source}:${signal.sourceJobId}`,
    requisitionId: boardJob?.requisitionId ?? null,
    title: boardJob?.title ?? signal.title,
    company: signal.company,
    location: boardJob?.location ?? signal.location,
    workplaceType: boardJob?.workplaceType ?? null,
    applyUrl,
    description: boardJob?.description ?? "",
    postedAt: signal.sourcePostedAt ?? boardJob?.postedAt ?? null,
    postedAtText: signal.sourcePostedText ?? boardJob?.postedAtText ?? null,
  };
}

async function persistOfficialSignal(
  signal: SupplementalRadarSignal,
  job: AtsJob,
): Promise<{ outcome: "new" | "updated" | "unchanged"; jobId: string | null }> {
  const resolved = inferResolvedSource(job.applyUrl);
  const outcome = await upsertClassifiedAtsJob({
    job,
    source: resolved.source,
    atsType: resolved.atsType,
    atsTenant: resolved.atsTenant,
    classification: "QUALIFYING_INTERNSHIP",
    classificationReason:
      `Radar signal from ${signal.source} independently resolved to an original employer/ATS posting.`,
    now: new Date(),
  });
  await promoteCanonicalDirectJob(job, resolved.source, resolved.atsTenant);

  const canonical = await prisma.job.findFirst({
    where: {
      OR: [
        { officialApplicationUrl: job.applyUrl },
        { officialApplyUrl: job.applyUrl },
        { url: job.applyUrl },
        { sourceJobId: job.sourceJobId },
        { company: signal.company, title: job.title },
      ],
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  return { outcome, jobId: canonical?.id ?? null };
}

async function resolveSignal(
  signal: SupplementalRadarSignal,
  companies: CompanyForListing[],
  exactMap: Map<string, CompanyForListing>,
): Promise<{
  state: "resolved" | "retry";
  jobId: string | null;
  outcome: "new" | "updated" | "unchanged" | null;
  error: string | null;
}> {
  const direct = signal.sourceUrl && !isAggregatorUrl(signal.sourceUrl)
    && isValidOfficialApplicationUrl(signal.sourceUrl)
    ? signal.sourceUrl
    : null;

  if (direct) {
    try {
      const saved = await persistOfficialSignal(signal, asAtsJob(signal, direct));
      return { state: "resolved", jobId: saved.jobId, outcome: saved.outcome, error: null };
    } catch (error) {
      return {
        state: "retry",
        jobId: null,
        outcome: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const config = findCompanyConfig(signal.company, companies, exactMap);

  // Intern List itself is an approved radar. Its public detail page can contain
  // the outbound original posting even for an employer that has never appeared
  // in our Company table. Use the existing guarded destination resolver here,
  // but ONLY for Intern List/Jobright pages. Personal LinkedIn/Indeed/etc.
  // signals deliberately do not cause Internship Pilot to crawl those services.
  if (
    signal.source === "intern-list-public"
    && isInternListSourcePage(signal.sourceUrl)
  ) {
    try {
      const destination = await resolveOfficialJobDestination(
        {
          sourceListingUrl: signal.sourceUrl,
          employerCareerUrl: config?.careersUrl ?? null,
        },
        fetch,
        new Date(),
        { followSourceListings: true },
      );
      const official = destination.resolutionStatus === "RESOLVED"
        && destination.officialApplicationUrl
        && !isAggregatorUrl(destination.officialApplicationUrl)
        ? destination.officialApplicationUrl
        : null;
      if (official) {
        const saved = await persistOfficialSignal(signal, asAtsJob(signal, official));
        return { state: "resolved", jobId: saved.jobId, outcome: saved.outcome, error: null };
      }
    } catch {
      // Continue to the employer-board matching path. The queue keeps the
      // signal durable if neither route can resolve it on this attempt.
    }
  }

  if (!config || !config.atsType || config.atsType === "unknown") {
    return {
      state: "retry",
      jobId: null,
      outcome: null,
      error: "Employer is not mapped to a supported official ATS board yet.",
    };
  }

  try {
    const result = await listJobsForCompany({
      ...config,
      lastETag: null,
      lastModified: null,
      contentHash: null,
    });
    if (!result.supported || result.jobs.length === 0) {
      return {
        state: "retry",
        jobId: null,
        outcome: null,
        error: "Official employer board did not return a resolvable posting.",
      };
    }

    let best: { job: AtsJob; score: number } | null = null;
    for (const job of result.jobs) {
      const score = scoreOfficialBoardMatch(
        { title: signal.title, location: signal.location },
        job,
      );
      if (!best || score > best.score) best = { job, score };
    }

    if (!best || best.score < 0.68 || !best.job.applyUrl || isAggregatorUrl(best.job.applyUrl)) {
      return {
        state: "retry",
        jobId: null,
        outcome: null,
        error: "No sufficiently strong original employer-board match yet.",
      };
    }

    const saved = await persistOfficialSignal(
      signal,
      asAtsJob(signal, best.job.applyUrl, best.job),
    );
    return { state: "resolved", jobId: saved.jobId, outcome: saved.outcome, error: null };
  } catch (error) {
    return {
      state: "retry",
      jobId: null,
      outcome: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function enqueueSupplementalRadarSignals(
  signals: SupplementalRadarSignal[],
  now = new Date(),
): Promise<{ considered: number; enqueued: number; alreadyQueued: number }> {
  if (signals.length === 0) return { considered: 0, enqueued: 0, alreadyQueued: 0 };

  const unique = new Map<string, SupplementalRadarSignal>();
  for (const signal of signals) {
    const title = signal.title.trim();
    const company = signal.company.trim();
    if (!title || !company) continue;
    const normalized = { ...signal, title, company };
    unique.set(eventKey(normalized), normalized);
  }

  const entries = [...unique.entries()];
  const existing = await prisma.appSetting.findMany({
    where: { key: { in: entries.map(([key]) => key) } },
    select: { key: true },
  });
  const existingKeys = new Set(existing.map((row) => row.key));
  const pending = entries.filter(([key]) => !existingKeys.has(key));

  if (pending.length > 0) {
    await prisma.appSetting.createMany({
      data: pending.map(([key, signal]) => {
        const record: QueueRecord = {
          version: 1,
          state: "pending",
          signal: serializeSignal(signal),
          attempts: 0,
          firstQueuedAt: now.toISOString(),
          lastAttemptAt: null,
          nextAttemptAt: now.toISOString(),
          resolvedAt: null,
          resolvedJobId: null,
          lastError: null,
        };
        return { key, value: JSON.stringify(record) };
      }),
      skipDuplicates: true,
    });
  }

  return {
    considered: entries.length,
    enqueued: pending.length,
    alreadyQueued: entries.length - pending.length,
  };
}

export async function enqueueInternListPublicRadar(
  options: { maxPages?: number; maxJobs?: number; concurrency?: number } = {},
): Promise<{
  sourceFetched: number;
  pagesFetched: number;
  pagesFailed: number;
  maxPagesReached: boolean;
  maxJobsReached: boolean;
  considered: number;
  enqueued: number;
  alreadyQueued: number;
}> {
  const now = new Date();
  const source = await fetchInternListPublicRadar({ ...options, capturedAt: now });
  const signals: SupplementalRadarSignal[] = source.jobs.map((job) => ({
    source: "intern-list-public",
    sourceJobId: job.sourceJobId,
    title: job.title,
    company: job.company,
    location: job.location,
    sourceUrl: job.officialApplicationUrl ?? job.originalJobPostUrl ?? job.sourceListingUrl ?? job.applyUrl,
    sourcePostedAt: job.sourcePostedAt,
    sourcePostedText: job.sourcePostedText,
  }));
  const queued = await enqueueSupplementalRadarSignals(signals, now);

  const cursor: InternListCursor = {
    version: 1,
    source: "intern-list-public",
    lastCheckedAt: now.toISOString(),
    jobsSeen: source.jobs.length,
    pagesFetched: source.pagesFetched,
    pagesFailed: source.pagesFailed,
    maxPagesReached: source.maxPagesReached,
    maxJobsReached: source.maxJobsReached,
  };
  await prisma.appSetting.upsert({
    where: { key: INTERN_LIST_CURSOR_KEY },
    create: { key: INTERN_LIST_CURSOR_KEY, value: JSON.stringify(cursor) },
    update: { value: JSON.stringify(cursor) },
  });

  return {
    sourceFetched: source.jobs.length,
    pagesFetched: source.pagesFetched,
    pagesFailed: source.pagesFailed,
    maxPagesReached: source.maxPagesReached,
    maxJobsReached: source.maxJobsReached,
    ...queued,
  };
}

export async function processSupplementalRadarQueue(limit = 80): Promise<{
  due: number;
  processed: number;
  resolved: number;
  retried: number;
  abandoned: number;
  newCount: number;
  updatedCount: number;
}> {
  const now = new Date();
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: EVENT_PREFIX } },
    take: MAX_EVENT_ROWS,
  });

  const due = rows
    .map((row) => ({ row, record: parseJson<QueueRecord>(row.value) }))
    .filter(
      (item): item is { row: (typeof rows)[number]; record: QueueRecord } =>
        Boolean(item.record)
        && (item.record!.state === "pending" || item.record!.state === "retry")
        && new Date(item.record!.nextAttemptAt) <= now,
    )
    .sort((a, b) => {
      const aPosted = a.record.signal.sourcePostedAt
        ? new Date(a.record.signal.sourcePostedAt).getTime()
        : new Date(a.record.firstQueuedAt).getTime();
      const bPosted = b.record.signal.sourcePostedAt
        ? new Date(b.record.signal.sourcePostedAt).getTime()
        : new Date(b.record.firstQueuedAt).getTime();
      return bPosted - aPosted;
    })
    .slice(0, Math.max(1, Math.min(limit, 250)));

  // Empty-work fast path: nothing due means there is no signal to resolve
  // against a company board, so skip the company-table read entirely rather
  // than fetching it on every tick regardless of whether it will be used.
  if (due.length === 0) {
    return { due: 0, processed: 0, resolved: 0, retried: 0, abandoned: 0, newCount: 0, updatedCount: 0 };
  }

  // Radar signals are only hints. They may resolve through ANY company whose
  // official ATS configuration we already know; the signal itself never makes
  // an aggregator URL trusted. Intern List signals get one additional approved
  // route: their public detail page may reveal the outbound original posting.
  const companies: CompanyForListing[] = await prisma.company.findMany({
    where: { monitoringStatus: "active" },
    select: {
      name: true,
      atsType: true,
      atsIdentifier: true,
      careersUrl: true,
      lastETag: true,
      lastModified: true,
      contentHash: true,
    },
  });
  const exactMap = new Map(companies.map((company) => [companyKey(company.name), company]));

  let resolved = 0;
  let retried = 0;
  let abandoned = 0;
  let newCount = 0;
  let updatedCount = 0;
  let cursor = 0;

  const workers = Array.from({ length: Math.min(8, due.length) }, async () => {
    while (cursor < due.length) {
      const item = due[cursor++]!;
      const record = item.record;
      const signal = deserializeSignal(record.signal);
      const result = await resolveSignal(signal, companies, exactMap);
      const attempts = record.attempts + 1;
      const referenceTime = signal.sourcePostedAt?.getTime()
        ?? new Date(record.firstQueuedAt).getTime();
      const tooOld = now.getTime() - referenceTime > maxAgeMs(signal.source);
      const shouldAbandon = result.state === "retry"
        && (attempts >= maxAttempts(signal.source) || tooOld);
      const state: QueueState = result.state === "resolved"
        ? "resolved"
        : shouldAbandon
          ? "abandoned"
          : "retry";

      if (state === "resolved") {
        resolved += 1;
        if (result.outcome === "new") newCount += 1;
        else if (result.outcome === "updated") updatedCount += 1;
      } else if (state === "abandoned") {
        abandoned += 1;
      } else {
        retried += 1;
      }

      const updated: QueueRecord = {
        ...record,
        state,
        attempts,
        lastAttemptAt: now.toISOString(),
        nextAttemptAt: state === "retry" ? nextRetryAt(attempts).toISOString() : now.toISOString(),
        resolvedAt: state === "resolved" ? now.toISOString() : record.resolvedAt,
        resolvedJobId: result.jobId ?? record.resolvedJobId,
        lastError: result.error,
      };
      await prisma.appSetting.update({
        where: { key: item.row.key },
        data: { value: JSON.stringify(updated) },
      });
    }
  });
  await Promise.all(workers);

  return {
    due: due.length,
    processed: due.length,
    resolved,
    retried,
    abandoned,
    newCount,
    updatedCount,
  };
}

export async function getSupplementalRadarHealth(): Promise<{
  pending: number;
  retry: number;
  resolved: number;
  abandoned: number;
  bySource: Record<string, { pending: number; retry: number; resolved: number; abandoned: number }>;
  internListCursor: InternListCursor | null;
}> {
  const [rows, cursorRow] = await Promise.all([
    prisma.appSetting.findMany({
      where: { key: { startsWith: EVENT_PREFIX } },
      select: { value: true },
      take: MAX_EVENT_ROWS,
    }),
    prisma.appSetting.findUnique({ where: { key: INTERN_LIST_CURSOR_KEY } }),
  ]);

  const totals = { pending: 0, retry: 0, resolved: 0, abandoned: 0 };
  const bySource: Record<string, typeof totals> = {};
  for (const row of rows) {
    const record = parseJson<QueueRecord>(row.value);
    if (!record) continue;
    if (!(record.state in totals)) continue;
    totals[record.state as keyof typeof totals] += 1;
    const source = record.signal.source;
    bySource[source] ??= { pending: 0, retry: 0, resolved: 0, abandoned: 0 };
    bySource[source][record.state as keyof typeof totals] += 1;
  }

  return {
    ...totals,
    bySource,
    internListCursor: parseJson<InternListCursor>(cursorRow?.value),
  };
}