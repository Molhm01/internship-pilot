import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { listJobsForCompany, type CompanyForListing } from "@/lib/ats";
import type { AtsJob } from "@/lib/ats/types";
import {
  isAggregatorUrl,
  isValidOfficialApplicationUrl,
} from "@/lib/applications/officialDestination";
import { promoteCanonicalDirectJob } from "@/lib/jobs/activeFeed";
import { inferResolvedSource } from "@/lib/sync/discoveryResolution";
import {
  fetchJobrightFreshSignals,
  type RawInternListJob,
} from "@/lib/sync/jobrightFreshDiscovery";
import { scoreOfficialBoardMatch } from "@/lib/sync/officialBoardMatch";
import { probeOfficialJobAvailability } from "@/lib/sync/freshness";
import { upsertClassifiedAtsJob } from "@/lib/sync/ingest";

const EVENT_PREFIX = "liveDiscovery:event:";
const CURSOR_KEY = "liveDiscovery:cursor:jobright-fresh";
const EVENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CURSOR_OVERLAP_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 12;

type QueueState = "pending" | "retry" | "resolved" | "closed" | "abandoned";

type SerializedSignal = Omit<
  RawInternListJob,
  "postedAt" | "sourcePostedAt"
> & {
  postedAt: string | null;
  sourcePostedAt: string | null;
};

type QueueRecord = {
  version: 1;
  source: "jobright-fresh";
  sourceJobId: string;
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

type CursorRecord = {
  version: 1;
  source: "jobright-fresh";
  lastCheckedAt: string;
  lastSourcePostedAt: string | null;
  sourceFresh: number;
  freshUnder24h: number;
  freshUnder72h: number;
  categoryCounts: Record<string, number>;
};

function serializeSignal(signal: RawInternListJob): SerializedSignal {
  return {
    ...signal,
    postedAt: signal.postedAt?.toISOString() ?? null,
    sourcePostedAt: signal.sourcePostedAt?.toISOString() ?? null,
  };
}

function deserializeSignal(signal: SerializedSignal): RawInternListJob {
  return {
    ...signal,
    postedAt: signal.postedAt ? new Date(signal.postedAt) : null,
    sourcePostedAt: signal.sourcePostedAt ? new Date(signal.sourcePostedAt) : null,
  };
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function eventKey(sourceJobId: string): string {
  const digest = createHash("sha256").update(sourceJobId).digest("hex").slice(0, 40);
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

function asAtsJob(signal: RawInternListJob, applyUrl: string, boardJob?: AtsJob | null): AtsJob {
  return {
    sourceJobId: boardJob?.sourceJobId ?? `jobright-fresh:${signal.sourceJobId}`,
    requisitionId: boardJob?.requisitionId ?? null,
    title: boardJob?.title ?? signal.title,
    company: signal.company,
    location: boardJob?.location ?? signal.location,
    workplaceType: boardJob?.workplaceType ?? signal.workModel,
    applyUrl,
    description: boardJob?.description || signal.qualifications || "",
    postedAt: signal.sourcePostedAt ?? boardJob?.postedAt ?? null,
    postedAtText: signal.sourcePostedText ?? boardJob?.postedAtText ?? null,
  };
}

async function persistOfficialSignal(
  signal: RawInternListJob,
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
      "Live discovery signal independently resolved to an original employer/ATS posting.",
    now: new Date(),
  });
  await promoteCanonicalDirectJob(job, resolved.source, resolved.atsTenant);

  const canonical = await prisma.job.findFirst({
    where: {
      activeFeed: true,
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
  signal: RawInternListJob,
  companies: CompanyForListing[],
  exactMap: Map<string, CompanyForListing>,
): Promise<{
  state: "resolved" | "closed" | "retry";
  jobId: string | null;
  outcome: "new" | "updated" | "unchanged" | null;
  error: string | null;
}> {
  const direct = [signal.officialApplicationUrl, signal.originalJobPostUrl, signal.applyUrl]
    .find(
      (value): value is string =>
        Boolean(value) && !isAggregatorUrl(value) && isValidOfficialApplicationUrl(value),
    );

  if (direct) {
    const probe = await probeOfficialJobAvailability(direct);
    if (probe.state === "closed") {
      return { state: "closed", jobId: null, outcome: null, error: probe.reason };
    }
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
  if (!config || !config.atsType || config.atsType === "unknown") {
    return {
      state: "retry",
      jobId: null,
      outcome: null,
      error: "Employer is not yet mapped to a supported official ATS board.",
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
        error: "Official ATS board did not return a resolvable posting.",
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

    if (!best || best.score < 0.72 || !best.job.applyUrl || isAggregatorUrl(best.job.applyUrl)) {
      return {
        state: "retry",
        jobId: null,
        outcome: null,
        error: "No sufficiently strong original-board match yet.",
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

function nextRetryAt(attempts: number): Date {
  const minutes = Math.min(120, 10 * 2 ** Math.min(attempts, 4));
  return new Date(Date.now() + minutes * 60 * 1000);
}

export async function enqueueJobrightFreshSignals(now = new Date()): Promise<{
  sourceFresh: number;
  freshUnder24h: number;
  freshUnder72h: number;
  considered: number;
  enqueued: number;
  alreadyQueued: number;
  cursorAdvancedTo: string | null;
  categoryCounts: Record<string, number>;
}> {
  const source = await fetchJobrightFreshSignals(now);
  const cursorSetting = await prisma.appSetting.findUnique({ where: { key: CURSOR_KEY } });
  const cursor = parseJson<CursorRecord>(cursorSetting?.value);
  const previous = cursor?.lastSourcePostedAt ? new Date(cursor.lastSourcePostedAt) : null;
  const threshold = previous
    ? new Date(previous.getTime() - CURSOR_OVERLAP_MS)
    : new Date(now.getTime() - EVENT_MAX_AGE_MS);

  const consideredSignals = source.jobs.filter(
    (signal) => signal.sourcePostedAt && signal.sourcePostedAt >= threshold,
  );
  const keys = consideredSignals.map((signal) => eventKey(signal.sourceJobId));
  const existing = keys.length
    ? await prisma.appSetting.findMany({
        where: { key: { in: keys } },
        select: { key: true },
      })
    : [];
  const existingKeys = new Set(existing.map((row) => row.key));
  const newSignals = consideredSignals.filter(
    (signal) => !existingKeys.has(eventKey(signal.sourceJobId)),
  );

  if (newSignals.length > 0) {
    await prisma.appSetting.createMany({
      data: newSignals.map((signal) => {
        const record: QueueRecord = {
          version: 1,
          source: "jobright-fresh",
          sourceJobId: signal.sourceJobId,
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
        return { key: eventKey(signal.sourceJobId), value: JSON.stringify(record) };
      }),
      skipDuplicates: true,
    });
  }

  const latest = source.jobs.reduce<Date | null>((best, signal) => {
    if (!signal.sourcePostedAt) return best;
    return !best || signal.sourcePostedAt > best ? signal.sourcePostedAt : best;
  }, previous);
  const cursorValue: CursorRecord = {
    version: 1,
    source: "jobright-fresh",
    lastCheckedAt: now.toISOString(),
    lastSourcePostedAt: latest?.toISOString() ?? null,
    sourceFresh: source.jobs.length,
    freshUnder24h: source.freshUnder24h,
    freshUnder72h: source.freshUnder72h,
    categoryCounts: source.categoryCounts,
  };
  await prisma.appSetting.upsert({
    where: { key: CURSOR_KEY },
    create: { key: CURSOR_KEY, value: JSON.stringify(cursorValue) },
    update: { value: JSON.stringify(cursorValue) },
  });

  return {
    sourceFresh: source.jobs.length,
    freshUnder24h: source.freshUnder24h,
    freshUnder72h: source.freshUnder72h,
    considered: consideredSignals.length,
    enqueued: newSignals.length,
    alreadyQueued: consideredSignals.length - newSignals.length,
    cursorAdvancedTo: latest?.toISOString() ?? null,
    categoryCounts: source.categoryCounts,
  };
}

export async function processLiveDiscoveryQueue(limit = 60): Promise<{
  due: number;
  processed: number;
  resolved: number;
  closed: number;
  retried: number;
  abandoned: number;
  newCount: number;
  updatedCount: number;
}> {
  const now = new Date();
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: EVENT_PREFIX } },
    take: 1500,
  });

  const due = rows
    .map((row) => ({ row, record: parseJson<QueueRecord>(row.value) }))
    .filter(
      (item): item is { row: (typeof rows)[number]; record: QueueRecord } =>
        Boolean(item.record) &&
        (item.record!.state === "pending" || item.record!.state === "retry") &&
        new Date(item.record!.nextAttemptAt) <= now,
    )
    .sort(
      (a, b) =>
        (b.record.signal.sourcePostedAt
          ? new Date(b.record.signal.sourcePostedAt).getTime()
          : 0) -
        (a.record.signal.sourcePostedAt
          ? new Date(a.record.signal.sourcePostedAt).getTime()
          : 0),
    )
    .slice(0, Math.max(1, Math.min(limit, 200)));

  const companies: CompanyForListing[] = await prisma.company.findMany({
    where: { allowlisted: true, monitoringStatus: "active" },
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
  let closed = 0;
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
      const sourcePostedAt = signal.sourcePostedAt?.getTime() ?? 0;
      const tooOld = sourcePostedAt > 0 && now.getTime() - sourcePostedAt > EVENT_MAX_AGE_MS;
      const shouldAbandon = result.state === "retry" && (attempts >= MAX_ATTEMPTS || tooOld);

      let state: QueueState;
      if (result.state === "resolved") state = "resolved";
      else if (result.state === "closed") state = "closed";
      else if (shouldAbandon) state = "abandoned";
      else state = "retry";

      if (state === "resolved") {
        resolved += 1;
        if (result.outcome === "new") newCount += 1;
        else if (result.outcome === "updated") updatedCount += 1;
      } else if (state === "closed") closed += 1;
      else if (state === "abandoned") abandoned += 1;
      else retried += 1;

      const updated: QueueRecord = {
        ...record,
        state,
        attempts,
        lastAttemptAt: now.toISOString(),
        nextAttemptAt:
          state === "retry" ? nextRetryAt(attempts).toISOString() : now.toISOString(),
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
    closed,
    retried,
    abandoned,
    newCount,
    updatedCount,
  };
}

export async function getLiveDiscoveryQueueHealth(): Promise<{
  pending: number;
  retry: number;
  resolved: number;
  closed: number;
  abandoned: number;
  cursor: CursorRecord | null;
}> {
  const [rows, cursorSetting] = await Promise.all([
    prisma.appSetting.findMany({
      where: { key: { startsWith: EVENT_PREFIX } },
      select: { value: true },
      take: 2000,
    }),
    prisma.appSetting.findUnique({ where: { key: CURSOR_KEY } }),
  ]);
  const counts = { pending: 0, retry: 0, resolved: 0, closed: 0, abandoned: 0 };
  for (const row of rows) {
    const record = parseJson<QueueRecord>(row.value);
    if (!record) continue;
    if (record.state in counts) counts[record.state as keyof typeof counts] += 1;
  }
  return { ...counts, cursor: parseJson<CursorRecord>(cursorSetting?.value) };
}
