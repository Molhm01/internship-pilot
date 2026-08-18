"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type SyncStatus = {
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  newJobsLastRun: number;
  updatedJobsLastRun: number;
  verifiedCount: number;
  needsReviewCount: number;
  closedCount: number;
  pendingCount: number;
  recentErrorCount: number;
};

type CoverageDiagnostics = {
  sourceCandidates: number;
  sourceCompanies: number;
  registryCompanies: number;
  registryMatched: number;
  registryMissing: number;
  withConfiguredSource: number;
  withoutConfiguredSource: number;
  boardSampled: number;
  boardMatched: number;
  boardNoMatch: number;
  boardErrors: number;
  topMissingCompanies: Array<{ company: string; count: number }>;
};

type EmployerSweepSummary = {
  checked: number;
  totalEligible: number;
  remaining: number;
  stoppedForTimeBudget: boolean;
};

const AUTOMATIC_SYNC_CATCHUP_AFTER_MS = 45 * 60 * 1000;
const AUTOMATIC_SYNC_STALE_AFTER_MS = 75 * 60 * 1000;
const AUTOMATIC_RECOVERY_COOLDOWN_MS = 10 * 60 * 1000;

type AutomaticSyncHealth = "healthy" | "recovering" | "stale" | "error" | "waiting";

function syncAgeMs(status: SyncStatus | null): number | null {
  if (!status?.lastSyncAt) return null;
  const timestamp = new Date(status.lastSyncAt).getTime();
  return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : null;
}

function needsAutomaticCatchup(status: SyncStatus | null): boolean {
  if (!status?.lastSyncAt) return true;
  if (status.lastSyncStatus === "error") return true;
  const age = syncAgeMs(status);
  return age === null || age > AUTOMATIC_SYNC_CATCHUP_AFTER_MS;
}

function automaticSyncHealth(
  status: SyncStatus | null,
  automaticRecovering: boolean,
): AutomaticSyncHealth {
  if (automaticRecovering) return "recovering";
  if (!status?.lastSyncAt) return "waiting";
  if (status.lastSyncStatus === "error") return "error";
  const age = syncAgeMs(status);
  if (age === null) return "stale";
  return age > AUTOMATIC_SYNC_STALE_AFTER_MS ? "stale" : "healthy";
}

const HEALTH_COPY: Record<AutomaticSyncHealth, { label: string; className: string; dotClassName: string; detail: string }> = {
  healthy: {
    label: "Automatic sync healthy",
    className: "text-emerald-500",
    dotClassName: "bg-emerald-500",
    detail: "The external schedule targets every 30 minutes. Discover also self-heals missed runs while this page is open.",
  },
  recovering: {
    label: "Catching up automatically",
    className: "text-cyan-400",
    dotClassName: "bg-cyan-400",
    detail: "A stale feed was detected, so Discover started a real employer sweep automatically. No button press is required.",
  },
  stale: {
    label: "Automatic sync stale",
    className: "text-amber-500",
    dotClassName: "bg-amber-500",
    detail: "The external scheduler missed its freshness target. Discover will automatically retry a catch-up sweep while this page is open.",
  },
  error: {
    label: "Automatic sync error",
    className: "text-rose-500",
    dotClassName: "bg-rose-500",
    detail: "The latest employer sync failed. Discover will automatically retry after the recovery cooldown; Run sync now remains an emergency fallback.",
  },
  waiting: {
    label: "Waiting for automatic sync",
    className: "text-amber-500",
    dotClassName: "bg-amber-500",
    detail: "No completed employer sync is recorded yet. Discover will start one automatically while this page is open.",
  },
};

export default function SyncStatusPanel({ onSynced }: { onSynced: () => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [automaticRecovering, setAutomaticRecovering] = useState(false);
  const [coverage, setCoverage] = useState<CoverageDiagnostics | null>(null);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [employerSweep, setEmployerSweep] = useState<EmployerSweepSummary | null>(null);
  const lastObservedSyncAt = useRef<string | null>(null);
  const lastAutomaticRecoveryAttemptAt = useRef(0);

  const load = useCallback(
    async ({ notify = false }: { notify?: boolean } = {}): Promise<SyncStatus | null> => {
      const res = await fetch("/api/sync/status", { cache: "no-store" });
      if (!res.ok) return null;

      const next = (await res.json()) as SyncStatus;
      const previousSyncAt = lastObservedSyncAt.current;
      lastObservedSyncAt.current = next.lastSyncAt;
      setStatus(next);

      if (
        notify &&
        previousSyncAt &&
        next.lastSyncAt &&
        next.lastSyncAt !== previousSyncAt
      ) {
        onSynced();
      }
      return next;
    },
    [onSynced],
  );

  const runAutomaticCatchup = useCallback(async (observed: SyncStatus | null) => {
    if (!needsAutomaticCatchup(observed)) return;
    if (document.visibilityState !== "visible") return;

    const now = Date.now();
    if (now - lastAutomaticRecoveryAttemptAt.current < AUTOMATIC_RECOVERY_COOLDOWN_MS) return;
    lastAutomaticRecoveryAttemptAt.current = now;
    setAutomaticRecovering(true);

    try {
      const res = await fetch("/api/sync/run", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCoverageError(data.error ?? "Automatic catch-up sync failed.");
        return;
      }

      if (data.companies) {
        setEmployerSweep({
          checked: Number(data.companies.checked ?? 0),
          totalEligible: Number(data.companies.totalEligible ?? 0),
          remaining: Number(data.companySweepRemaining ?? 0),
          stoppedForTimeBudget: Boolean(data.companies.stoppedForTimeBudget),
        });
      }
    } catch (error) {
      setCoverageError(error instanceof Error ? error.message : "Automatic catch-up sync failed.");
    } finally {
      setAutomaticRecovering(false);
      await load({ notify: true });
    }
  }, [load]);

  useEffect(() => {
    const checkFreshness = async () => {
      if (document.visibilityState !== "visible") return;
      const next = await load({ notify: true });
      if (next) void runAutomaticCatchup(next);
    };

    void checkFreshness();
    const interval = window.setInterval(checkFreshness, 60_000);
    document.addEventListener("visibilitychange", checkFreshness);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", checkFreshness);
    };
  }, [load, runAutomaticCatchup]);

  async function loadCoverageDiagnostics() {
    setCoverageError(null);
    try {
      const res = await fetch("/api/sync/coverage-diagnostics", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setCoverage(null);
        setCoverageError(data.error ?? "Coverage diagnostics failed.");
        return;
      }
      setCoverage(data as CoverageDiagnostics);
    } catch (error) {
      setCoverage(null);
      setCoverageError(error instanceof Error ? error.message : "Coverage diagnostics failed.");
    }
  }

  async function handleSyncNow() {
    setSyncing(true);
    setCoverage(null);
    setCoverageError(null);
    setEmployerSweep(null);
    try {
      const res = await fetch("/api/sync/run", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCoverageError(data.error ?? "Sync failed.");
        return;
      }

      if (data.companies) {
        setEmployerSweep({
          checked: Number(data.companies.checked ?? 0),
          totalEligible: Number(data.companies.totalEligible ?? 0),
          remaining: Number(data.companySweepRemaining ?? 0),
          stoppedForTimeBudget: Boolean(data.companies.stoppedForTimeBudget),
        });
      }

      await Promise.all([load({ notify: true }), loadCoverageDiagnostics()]);
    } finally {
      setSyncing(false);
    }
  }

  const health = automaticSyncHealth(status, automaticRecovering);
  const healthCopy = HEALTH_COPY[health];

  return (
    <section className="bg-surface rounded-lg border border-hairline p-4 flex flex-wrap items-center justify-between gap-4">
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <div>
          <span className="text-tertiary">Last sync: </span>
          <span className="font-medium text-primary">
            {status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : "never"}
          </span>
        </div>
        <div>
          <span className="text-tertiary">New (last run): </span>
          <span className="font-medium text-primary">{status?.newJobsLastRun ?? 0}</span>
        </div>
        <div>
          <span className="text-emerald-600">Verified: </span>
          <span className="font-medium text-primary">{status?.verifiedCount ?? 0}</span>
        </div>
        <div>
          <span className="text-amber-600">Needs review: </span>
          <span className="font-medium text-primary">{status?.needsReviewCount ?? 0}</span>
        </div>
        <div>
          <span className="text-rose-600">Closed: </span>
          <span className="font-medium text-primary">{status?.closedCount ?? 0}</span>
        </div>
        <div>
          <span className="text-tertiary">Pending verification: </span>
          <span className="font-medium text-primary">{status?.pendingCount ?? 0}</span>
        </div>
        {(status?.recentErrorCount ?? 0) > 0 && (
          <div>
            <span className="text-rose-600">Sync errors (24h): </span>
            <span className="font-medium text-primary">{status?.recentErrorCount}</span>
          </div>
        )}
      </div>
      <button
        onClick={handleSyncNow}
        disabled={syncing || automaticRecovering}
        className="rounded-lg bg-accent text-white text-sm font-medium px-4 py-2 disabled:opacity-40 hover:bg-accent-dark transition-colors shrink-0"
      >
        {automaticRecovering ? "Catching up…" : syncing ? "Sweeping employers…" : "Run sync now"}
      </button>

      <div className="basis-full flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-tertiary">
        <span className={`inline-flex items-center gap-1.5 font-medium ${healthCopy.className}`}>
          <span className={`size-1.5 rounded-full ${healthCopy.dotClassName}`} aria-hidden="true" />
          {healthCopy.label}
        </span>
        <span>{healthCopy.detail}</span>
      </div>

      {employerSweep && (
        <div className="basis-full rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs leading-5 text-secondary">
          <span className="font-semibold text-primary">Employer sweep:</span>{" "}
          {employerSweep.checked} / {employerSweep.totalEligible} companies checked · {employerSweep.remaining} remaining
          {employerSweep.stoppedForTimeBudget && employerSweep.remaining > 0
            ? " · time budget reached; the next run resumes with the oldest remaining companies"
            : ""}
        </div>
      )}

      {coverage && (
        <div className="basis-full rounded-md border border-hairline bg-surface-raised px-3 py-2 text-xs leading-5 text-secondary">
          <span className="font-semibold text-primary">Coverage diagnostic:</span>{" "}
          {coverage.sourceCandidates} source jobs · {coverage.sourceCompanies} companies · {coverage.registryMatched} registry matches · {coverage.registryMissing} missing registry · {coverage.withConfiguredSource} with ATS/careers source · {coverage.withoutConfiguredSource} without source · {coverage.boardMatched}/{coverage.boardSampled} official-board matches
          {coverage.boardErrors > 0 ? ` · ${coverage.boardErrors} board errors` : ""}
          {coverage.topMissingCompanies.length > 0 && (
            <div className="mt-1 text-tertiary">
              Top missing companies: {coverage.topMissingCompanies.map((item) => `${item.company} (${item.count})`).join(", ")}
            </div>
          )}
        </div>
      )}

      {coverageError && (
        <div className="basis-full rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-500">
          Sync diagnostic: {coverageError}
        </div>
      )}
    </section>
  );
}
