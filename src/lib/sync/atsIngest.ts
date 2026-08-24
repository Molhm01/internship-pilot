// Direct-from-employer ATS ingestion.
//
// This is the PRIMARY growth path for new jobs. It now uses the same universal
// ATS dispatcher as company discovery, so Greenhouse, Lever, Ashby,
// SmartRecruiters, and Workday all flow through one normalization path.

import { prisma } from "@/lib/db";
import { listJobsForCompany } from "@/lib/ats";
import type { AtsJob } from "@/lib/ats/types";
import { classifyInternship, type InternshipClassification } from "@/lib/sync/internshipClassifier";
import { upsertClassifiedAtsJob, canonicalizeJobUrl } from "@/lib/sync/ingest";
import { isTargetEngineeringRole } from "@/lib/sync/classify";
import { isUsableProviderConfig } from "@/lib/sync/officialDiscoveryMetrics";

export const SUPPORTED_OFFICIAL_PROVIDERS = [
  "greenhouse",
  "lever",
  "ashby",
  "workday",
  "smartrecruiters",
  "successfactors",
  "eightfold",
  "phenom",
  "icims",
] as const;
export type SupportedOfficialProvider = (typeof SUPPORTED_OFFICIAL_PROVIDERS)[number];

export type AtsEmployer = {
  name: string;
  atsType: SupportedOfficialProvider;
  atsIdentifier: string;
  careersUrl?: string | null;
};

export type AtsIngestMetrics = {
  employersChecked: number;
  employersWithBoard: number;
  employersFailed: number;
  rowsDiscovered: number;
  uniqueRows: number;
  qualifying: number;
  notInternship: number;
  uncertain: number;
  closed: number;
  parseFailures: number;
  inserted: number;
  updated: number;
  unchanged: number;
  duplicatesPrevented: number;
  persistenceFailures: number;
  officialUrlsConfirmed: number;
  bySource: Record<string, { discovered: number; qualifying: number; inserted: number; updated: number }>;
  failuresByReason: Record<string, number>;
  durationMs: number;
};

function emptyMetrics(): AtsIngestMetrics {
  return {
    employersChecked: 0,
    employersWithBoard: 0,
    employersFailed: 0,
    rowsDiscovered: 0,
    uniqueRows: 0,
    qualifying: 0,
    notInternship: 0,
    uncertain: 0,
    closed: 0,
    parseFailures: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    duplicatesPrevented: 0,
    persistenceFailures: 0,
    officialUrlsConfirmed: 0,
    bySource: {},
    failuresByReason: {},
    durationMs: 0,
  };
}

function bump(metrics: AtsIngestMetrics, source: string, field: "discovered" | "qualifying" | "inserted" | "updated") {
  metrics.bySource[source] ??= { discovered: 0, qualifying: 0, inserted: 0, updated: 0 };
  metrics.bySource[source][field] += 1;
}

function recordFailure(metrics: AtsIngestMetrics, reason: string) {
  metrics.failuresByReason[reason] = (metrics.failuresByReason[reason] ?? 0) + 1;
}

export function secureAtsUrl(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function sanitizeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code) return code;
  }
  if (error instanceof Error) {
    if (/timeout|abort/i.test(error.message)) return "TIMEOUT";
    if (/unique constraint/i.test(error.message)) return "UNIQUE_CONSTRAINT";
    if (/foreign key/i.test(error.message)) return "FOREIGN_KEY";
    if (/database|sqlite|locked/i.test(error.message)) return "DATABASE_ERROR";
    return "PERSISTENCE_FAILED";
  }
  return "UNKNOWN_ERROR";
}

async function listFor(employer: AtsEmployer): Promise<AtsJob[]> {
  const result = await listJobsForCompany({
    name: employer.name,
    atsType: employer.atsType,
    atsIdentifier: employer.atsIdentifier,
    careersUrl: employer.careersUrl ?? null,
  });
  if (!result.supported) {
    throw Object.assign(new Error(`Unsupported ATS adapter: ${employer.atsType}`), {
      code: "UNSUPPORTED_ATS",
    });
  }
  return result.jobs;
}

export type RunOptions = {
  throttleMs?: number;
  limit?: number;
  dryRun?: boolean;
  sleep?: (ms: number) => Promise<void>;
  listJobs?: (employer: AtsEmployer) => Promise<AtsJob[]>;
  persist?: typeof upsertClassifiedAtsJob;
  onProgress?: (message: string) => void;
  syncRunId?: string;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runAtsIngestion(
  employers: AtsEmployer[],
  options: RunOptions = {},
): Promise<AtsIngestMetrics> {
  const metrics = emptyMetrics();
  const startedAt = Date.now();
  const throttleMs = options.throttleMs ?? 300;
  const sleep = options.sleep ?? defaultSleep;
  const listJobs = options.listJobs ?? listFor;
  const persist = options.persist ?? upsertClassifiedAtsJob;
  const targets = options.limit ? employers.slice(0, options.limit) : employers;
  const syncRunId = options.syncRunId ?? `ats-${startedAt}-${Math.random().toString(36).slice(2, 10)}`;
  const capturedAt = new Date(startedAt);
  let rowIndex = 0;

  const seenUrls = new Set<string>();

  for (const employer of targets) {
    metrics.employersChecked += 1;

    let jobs: AtsJob[];
    try {
      jobs = await listJobs(employer);
    } catch (error) {
      metrics.employersFailed += 1;
      recordFailure(metrics, `BOARD_FETCH_${sanitizeErrorCode(error)}`);
      options.onProgress?.(`  ${employer.name}: board fetch failed (${sanitizeErrorCode(error)})`);
      if (throttleMs > 0) await sleep(throttleMs);
      continue;
    }

    if (jobs.length > 0) metrics.employersWithBoard += 1;

    for (const job of jobs) {
      metrics.rowsDiscovered += 1;
      bump(metrics, employer.atsType, "discovered");

      try {
        const secureUrl = secureAtsUrl(job.applyUrl);
        const canonical = secureUrl ? canonicalizeJobUrl(secureUrl) : null;
        if (!secureUrl || !canonical) {
          metrics.parseFailures += 1;
          recordFailure(metrics, "MISSING_OFFICIAL_URL");
          continue;
        }

        if (seenUrls.has(canonical)) {
          metrics.duplicatesPrevented += 1;
          continue;
        }
        seenUrls.add(canonical);
        metrics.uniqueRows += 1;

        const { classification, reason } = classifyInternship({
          title: job.title,
          description: job.description,
          employmentType: job.employmentType,
        });

        if (classification === "QUALIFYING_INTERNSHIP" && !isTargetEngineeringRole(job.title, job.description)) {
          metrics.notInternship += 1;
          recordFailure(metrics, "EXCLUDED_NOT_TARGET_ENGINEERING");
          continue;
        }

        countClassification(metrics, classification);

        if (classification !== "QUALIFYING_INTERNSHIP") {
          if (classification === "NOT_AN_INTERNSHIP") recordFailure(metrics, "EXCLUDED_NOT_AN_INTERNSHIP");
          else if (classification === "UNCERTAIN_CLASSIFICATION") recordFailure(metrics, "REVIEW_UNCERTAIN");
          else if (classification === "CONFIRMED_CLOSED") recordFailure(metrics, "EXCLUDED_CONFIRMED_CLOSED");
          else recordFailure(metrics, "PARSE_FAILED");
          continue;
        }

        bump(metrics, employer.atsType, "qualifying");
        metrics.officialUrlsConfirmed += 1;

        if (options.dryRun) continue;

        const result = await persist({
          job: { ...job, applyUrl: secureUrl },
          source: employer.atsType,
          atsType: employer.atsType,
          atsTenant: employer.atsIdentifier,
          classification,
          classificationReason: reason,
          syncRunId,
          rowIndex: rowIndex++,
          capturedAt,
        });

        if (result === "new") {
          metrics.inserted += 1;
          bump(metrics, employer.atsType, "inserted");
        } else if (result === "updated") {
          metrics.updated += 1;
          bump(metrics, employer.atsType, "updated");
        } else {
          metrics.unchanged += 1;
        }
      } catch (error) {
        metrics.persistenceFailures += 1;
        recordFailure(metrics, sanitizeErrorCode(error));
      }
    }

    options.onProgress?.(
      `  ${employer.name} (${employer.atsType}/${employer.atsIdentifier}): ${jobs.length} postings`,
    );
    if (throttleMs > 0) await sleep(throttleMs);
  }

  metrics.durationMs = Date.now() - startedAt;
  return metrics;
}

function countClassification(metrics: AtsIngestMetrics, classification: InternshipClassification) {
  switch (classification) {
    case "QUALIFYING_INTERNSHIP":
      metrics.qualifying += 1;
      break;
    case "NOT_AN_INTERNSHIP":
      metrics.notInternship += 1;
      break;
    case "UNCERTAIN_CLASSIFICATION":
      metrics.uncertain += 1;
      break;
    case "CONFIRMED_CLOSED":
      metrics.closed += 1;
      break;
    case "PARSE_FAILED":
      metrics.parseFailures += 1;
      break;
  }
}

/** Load allowlisted employers that already have a resolved supported board. */
export async function loadResolvedEmployers(vendors: SupportedOfficialProvider[]): Promise<AtsEmployer[]> {
  const rows = await prisma.company.findMany({
    where: {
      allowlisted: true,
      monitoringStatus: "active",
      atsType: { in: vendors },
      OR: [
        { atsIdentifier: { not: null } },
        { atsType: "successfactors", careersUrl: { not: null } },
      ],
    },
    select: { name: true, atsType: true, atsIdentifier: true, careersUrl: true },
    orderBy: { name: "asc" },
  });
  return rows
    .filter((row) => isUsableProviderConfig(row))
    .map((r) => ({
      name: r.name,
      atsType: r.atsType as SupportedOfficialProvider,
      atsIdentifier: r.atsIdentifier ?? r.careersUrl ?? r.name,
      careersUrl: r.careersUrl,
    }));
}

export async function recordSyncRun(
  metrics: AtsIngestMetrics,
  vendors: SupportedOfficialProvider[],
  status: "success" | "error",
  errorMessage?: string,
): Promise<string> {
  const run = await prisma.atsSyncRun.create({
    data: {
      vendors: JSON.stringify(vendors),
      status,
      finishedAt: new Date(),
      employersChecked: metrics.employersChecked,
      employersWithBoard: metrics.employersWithBoard,
      employersFailed: metrics.employersFailed,
      rowsDiscovered: metrics.rowsDiscovered,
      uniqueRows: metrics.uniqueRows,
      qualifying: metrics.qualifying,
      notInternship: metrics.notInternship,
      uncertain: metrics.uncertain,
      closed: metrics.closed,
      parseFailures: metrics.parseFailures,
      inserted: metrics.inserted,
      updated: metrics.updated,
      unchanged: metrics.unchanged,
      duplicatesPrevented: metrics.duplicatesPrevented,
      persistenceFailures: metrics.persistenceFailures,
      officialUrlsConfirmed: metrics.officialUrlsConfirmed,
      durationMs: metrics.durationMs,
      errorMessage: errorMessage ?? null,
      failureSummary: JSON.stringify(metrics.failuresByReason),
    },
  });
  return run.id;
}
