// Direct-from-employer ATS ingestion (Greenhouse / Lever / Ashby).
//
// This replaces Intern List / Jobright as the PRIMARY discovery path. Those
// records are preserved in the database and keep working; they are simply no
// longer where new jobs come from. See ATS_MIGRATION_PLAN.md.
//
// Two properties this module exists to guarantee:
//   1. One bad record never ends a run. Every posting is normalized,
//      classified, and persisted inside its own try/catch, and there is no
//      run-wide transaction that could roll back thousands of good rows.
//   2. Nothing is dropped silently. Every discovered row lands in exactly one
//      metric bucket, and every rejection carries a sanitized reason code.

import { prisma } from "@/lib/db";
import { listGreenhouseJobs } from "@/lib/ats/greenhouse";
import { listLeverJobs } from "@/lib/ats/lever";
import { listAshbyJobs } from "@/lib/ats/ashby";
import type { AtsJob } from "@/lib/ats/types";
import type { ResolvableAts } from "@/lib/ats/resolve";
import { classifyInternship, type InternshipClassification } from "@/lib/sync/internshipClassifier";
import { upsertClassifiedAtsJob, canonicalizeJobUrl } from "@/lib/sync/ingest";

export type AtsEmployer = {
  name: string;
  atsType: ResolvableAts;
  atsIdentifier: string;
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

/**
 * Reduce an unknown thrown value to a short, non-sensitive label. Never
 * includes job descriptions, tokens, cookies, or raw response bodies.
 */
/**
 * Upgrade an `http://` board URL to `https://`, leaving host and path alone.
 *
 * A few boards still advertise `http` in their absolute_url (CannonDesign
 * does). The destination policy accepts https only — correctly, since the
 * application worker navigates these URLs — so without this the posting would
 * be imported with no usable destination. Only the scheme is touched; unlike
 * the dedup canonicalizer this keeps `www.` and the exact path, because this
 * value is what a human actually opens.
 */
export function secureAtsUrl(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:") return null; // ftp:, mailto:, ... are not destinations
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
  switch (employer.atsType) {
    case "greenhouse":
      return listGreenhouseJobs(employer.atsIdentifier, employer.name);
    case "lever":
      return listLeverJobs(employer.atsIdentifier, employer.name);
    case "ashby":
      return listAshbyJobs(employer.atsIdentifier, employer.name);
  }
}

export type RunOptions = {
  /** Politeness delay between employer board requests. */
  throttleMs?: number;
  /** Cap the number of employers processed (used by --limit). */
  limit?: number;
  /** Persist nothing; only classify and count. */
  dryRun?: boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests so no network or database is required. */
  listJobs?: (employer: AtsEmployer) => Promise<AtsJob[]>;
  persist?: typeof upsertClassifiedAtsJob;
  onProgress?: (message: string) => void;
  /**
   * Identity of this run, stamped onto every persisted row together with its
   * position in the run. Only the newest run's positions are ever used as a
   * sort tiebreaker, so this must be unique per run.
   */
  syncRunId?: string;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Ingest every qualifying internship from the given employers' official ATS
 * boards. Pure orchestration — network and persistence are injectable.
 */
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

  // Cross-employer duplicate guard: the same canonical application URL
  // reached through two different board slugs is one posting.
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
        // --- Requirement: every imported job must carry a direct official
        // employer/ATS URL. No URL means we cannot send the user anywhere,
        // so the record is rejected with an explicit reason rather than
        // stored as an unusable stub.
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

        countClassification(metrics, classification);

        // Only qualifying internships are persisted as active jobs.
        // UNCERTAIN rows are counted and reported so they stay reviewable
        // rather than vanishing, but they are not silently published.
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
          // Persist the https-normalized destination, not the raw board value.
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
        // One malformed or unpersistable posting must not end the run.
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

/** Load the allowlisted employers that already have a resolved GLA board. */
export async function loadResolvedEmployers(vendors: ResolvableAts[]): Promise<AtsEmployer[]> {
  const rows = await prisma.company.findMany({
    where: {
      allowlisted: true,
      monitoringStatus: "active",
      atsType: { in: vendors },
      atsIdentifier: { not: null },
    },
    select: { name: true, atsType: true, atsIdentifier: true },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({
    name: r.name,
    atsType: r.atsType as ResolvableAts,
    atsIdentifier: r.atsIdentifier as string,
  }));
}

/** Persist a completed run's metrics as an auditable AtsSyncRun row. */
export async function recordSyncRun(
  metrics: AtsIngestMetrics,
  vendors: ResolvableAts[],
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
