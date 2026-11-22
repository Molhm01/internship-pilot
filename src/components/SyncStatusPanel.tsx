"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type SyncStatus = {
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastFreshSyncAt: string | null;
  lastFreshSyncStatus: string | null;
  lastLiveDiscoveryAt: string | null;
  newJobsLastRun: number;
  updatedJobsLastRun: number;
  activeCount: number;
  activeTarget: number;
  activeTargetReached: boolean;
  fresh6hCount?: number;
  fresh6hTarget?: number;
  fresh24hCount: number;
  fresh72hCount: number;
  fresh24hTarget: number;
  fresh72hTarget: number;
  freshnessTargetReached: boolean;
  latestSourcePostedAt: string | null;
  sourceLagMinutesP50: number | null;
  sourceLagMinutesP95: number | null;
  recentLagSampleSize: number;
  liveQueue: {
    pending: number;
    retry: number;
    resolved: number;
    closed: number;
    abandoned: number;
  } | null;
  multiSourceStatus?: Array<{
    source: string;
    label: string;
    fetched: number;
    freshUnder6h: number;
    freshUnder24h: number;
    persisted: number;
    status: "ok" | "partial" | "unavailable";
    note?: string;
  }>;
  verifiedCount: number;
  needsReviewCount: number;
  closedCount: number;
  pendingCount: number;
  recentErrorCount: number;
  aiScoringConfigured?: boolean;
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
const FRESHNESS_RECOVERY_COOLDOWN_MS = 30 * 60 * 1000;

type AutomaticAction = "catalog" | "fresh" | null;
type AutomaticSyncHealth =
  | "healthy"
  | "building"
  | "freshness"
  | "recovering"
  | "freshening"
  | "stale"
  | "error"
  | "waiting";

function syncAgeMs(status: SyncStatus | null): number | null {
  if (!status?.lastSyncAt) return null;
  const timestamp = new Date(status.lastSyncAt).getTime();
  return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : null;
}

function belowActiveTarget(status: SyncStatus | null): boolean {
  return Boolean(status && status.activeTarget > 0 && status.activeCount < status.activeTarget);
}

function belowFreshnessTarget(status: SyncStatus | null): boolean {
  if (!status) return false;
  return (
    status.fresh24hCount < status.fresh24hTarget ||
    status.fresh72hCount < status.fresh72hTarget
  );
}

function needsFullCatchup(status: SyncStatus | null): boolean {
  if (belowActiveTarget(status)) return true;
  if (!status?.lastSyncAt) return true;
  if (status.lastSyncStatus === "error") return true;
  const age = syncAgeMs(status);
  return age === null || age > AUTOMATIC_SYNC_CATCHUP_AFTER_MS;
}

function automaticSyncHealth(
  status: SyncStatus | null,
  automaticAction: AutomaticAction,
): AutomaticSyncHealth {
  if (automaticAction === "catalog") return "recovering";
  if (automaticAction === "fresh") return "freshening";
  if (!status?.lastSyncAt) return "waiting";
  if (status.lastSyncStatus === "error") return "error";
  if (belowActiveTarget(status)) return "building";
  if (belowFreshnessTarget(status)) return "freshness";
  const age = syncAgeMs(status);
  if (age === null) return "stale";
  return age > AUTOMATIC_SYNC_STALE_AFTER_MS ? "stale" : "healthy";
}

function minutesLabel(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1) return "<1m";
  if (value < 60) return `${Math.round(value)}m`;
  return `${(value / 60).toFixed(1)}h`;
}

const HEALTH_COPY: Record<AutomaticSyncHealth, { label: string; className: string; detail: string }> = {
  healthy: {
    label: "Live Radar Active",
    className: "text-positive",
    detail: "7-day freshness cutoff enforced. Older postings are pruned automatically.",
  },
  building: {
    label: "Syncing Fresh Roles",
    className: "text-accent-text",
    detail: "Pulling live engineering postings across ATS boards and radar feeds.",
  },
  freshness: {
    label: "Scanning Live Boards",
    className: "text-caution",
    detail: "Continuously monitoring LinkedIn, Indeed, Handshake, Intern-List, Jobright, and employer ATS boards.",
  },
  recovering: {
    label: "Running Full Sync",
    className: "text-accent-text",
    detail: "Refreshing approved employer boards and verifying application URLs.",
  },
  freshening: {
    label: "Checking Live Postings",
    className: "text-accent-text",
    detail: "Ingesting newly opened positions within the 7-day active window.",
  },
  stale: {
    label: "Sync Scheduled",
    className: "text-caution",
    detail: "Automatic sync will refresh fresh postings shortly.",
  },
  error: {
    label: "Sync Retry Queued",
    className: "text-critical",
    detail: "The last sweep encountered an issue and will retry automatically.",
  },
  waiting: {
    label: "Initializing Live Feed",
    className: "text-caution",
    detail: "Discover will start an automatic live scan while this page is open.",
  },
};

export default function SyncStatusPanel({ onSynced }: { onSynced: () => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [automaticAction, setAutomaticAction] = useState<AutomaticAction>(null);
  const [coverage, setCoverage] = useState<CoverageDiagnostics | null>(null);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [employerSweep, setEmployerSweep] = useState<EmployerSweepSummary | null>(null);
  const lastObservedDiscoveryAt = useRef<string | null>(null);
  const lastAutomaticRecoveryAttemptAt = useRef(0);
  const lastFreshnessRecoveryAttemptAt = useRef(0);

  const load = useCallback(
    async ({ notify = false }: { notify?: boolean } = {}): Promise<SyncStatus | null> => {
      const res = await fetch("/api/sync/status", { cache: "no-store" });
      if (!res.ok) return null;

      const next = (await res.json()) as SyncStatus;
      const nextDiscoveryAt = next.lastLiveDiscoveryAt ?? next.lastFreshSyncAt ?? next.lastSyncAt;
      const previousDiscoveryAt = lastObservedDiscoveryAt.current;
      lastObservedDiscoveryAt.current = nextDiscoveryAt;
      setStatus(next);

      if (
        notify &&
        nextDiscoveryAt &&
        nextDiscoveryAt !== previousDiscoveryAt
      ) {
        onSynced();
      }
      return next;
    },
    [onSynced],
  );

  const runAutomaticCatchup = useCallback(async (observed: SyncStatus | null) => {
    if (!observed || document.visibilityState !== "visible") return;

    const fullCatchup = needsFullCatchup(observed);
    const freshCatchup = !fullCatchup && belowFreshnessTarget(observed);
    if (!fullCatchup && !freshCatchup) return;

    const now = Date.now();
    if (fullCatchup) {
      if (now - lastAutomaticRecoveryAttemptAt.current < AUTOMATIC_RECOVERY_COOLDOWN_MS) return;
      lastAutomaticRecoveryAttemptAt.current = now;
    } else {
      if (now - lastFreshnessRecoveryAttemptAt.current < FRESHNESS_RECOVERY_COOLDOWN_MS) return;
      lastFreshnessRecoveryAttemptAt.current = now;
    }

    const action: AutomaticAction = fullCatchup ? "catalog" : "fresh";
    setAutomaticAction(action);

    try {
      const endpoint = fullCatchup ? "/api/sync/run" : "/api/sync/fresh";
      const res = await fetch(endpoint, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCoverageError(data.error ?? "Automatic sync failed.");
        return;
      }

      if (fullCatchup && data.companies) {
        setEmployerSweep({
          checked: Number(data.companies.checked ?? 0),
          totalEligible: Number(data.companies.totalEligible ?? 0),
          remaining: Number(data.companySweepRemaining ?? 0),
          stoppedForTimeBudget: Boolean(data.companies.stoppedForTimeBudget),
        });
      }

      onSynced();
    } catch (error) {
      setCoverageError(error instanceof Error ? error.message : "Automatic sync failed.");
    } finally {
      setAutomaticAction(null);
      await load({ notify: true });
    }
  }, [load, onSynced]);

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
      onSynced();
    } finally {
      setSyncing(false);
    }
  }

  const health = automaticSyncHealth(status, automaticAction);
  const healthCopy = HEALTH_COPY[health];
  const livePending = (status?.liveQueue?.pending ?? 0) + (status?.liveQueue?.retry ?? 0);

  return (
    <section className="rounded-lg border border-hairline bg-surface p-4 shadow-raised space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-small">
          <div>
            <span className={`font-semibold ${healthCopy.className}`}>{healthCopy.label}</span>
            <p className="text-micro text-tertiary">{healthCopy.detail}</p>
          </div>
          <div className="hidden h-6 w-px bg-hairline sm:block" aria-hidden />
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-micro text-tertiary tabular font-mono">
            <span>
              Active &le;7d: <strong className="text-primary">{status?.activeCount ?? 0}</strong>
              {status && status.activeCount < status.activeTarget ? ` / ${status.activeTarget}` : ""}
            </span>
            <span>
              &lt;24h: <strong className="text-primary">{status?.fresh24hCount ?? 0}</strong>
            </span>
            <span>
              Lag: <strong className="text-primary">{minutesLabel(status?.sourceLagMinutesP50)}</strong>
            </span>
            <span>
              Queue: <strong className="text-primary">{livePending}</strong>
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={handleSyncNow}
          disabled={syncing || automaticAction !== null}
          className="inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-md border border-line bg-canvas px-3 text-micro font-medium text-primary transition-colors hover:border-line-strong hover:bg-n-50 disabled:opacity-45"
        >
          {automaticAction === "fresh"
            ? "Scanning live…"
            : automaticAction === "catalog"
              ? "Importing…"
              : syncing
                ? "Sweeping…"
                : "Run sync now"}
        </button>
      </div>

      <details className="border-t border-hairline pt-2.5 text-micro text-secondary">
        <summary className="cursor-pointer font-medium text-tertiary hover:text-primary">
          Crawler &amp; Pipeline Details
        </summary>
        <div className="mt-3 space-y-2.5">
          <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-tertiary tabular">
            <span>Last sync: {status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : "never"}</span>
            <span>Live scan: {status?.lastLiveDiscoveryAt ? new Date(status.lastLiveDiscoveryAt).toLocaleTimeString() : "not yet"}</span>
            <span>New (last run): {status?.newJobsLastRun ?? 0}</span>
            <span>Verified: {status?.verifiedCount ?? 0}</span>
            <span>Fresh &lt;6h: {status?.fresh6hCount ?? 0}</span>
            <span>Fresh 72h: {status?.fresh72hCount ?? 0}</span>
            <span>Lag p50/p95: {minutesLabel(status?.sourceLagMinutesP50)} / {minutesLabel(status?.sourceLagMinutesP95)}</span>
          </div>

          {status?.multiSourceStatus && status.multiSourceStatus.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-tertiary">Crawlers:</span>
              {status.multiSourceStatus.map((ch) => (
                <span
                  key={ch.source}
                  title={ch.note ?? `${ch.fetched} found (${ch.freshUnder6h} under 6h)`}
                  className="inline-flex items-center gap-1.5 rounded border border-hairline bg-canvas px-2 py-0.5 font-mono text-[11px]"
                >
                  <span className="text-primary">{ch.label}</span>
                  <span className="text-tertiary">{ch.fetched}</span>
                  {ch.freshUnder6h > 0 && (
                    <span className="text-positive">({ch.freshUnder6h} &lt;6h)</span>
                  )}
                </span>
              ))}
            </div>
          )}

          {employerSweep && (
            <p className="text-secondary">
              <strong className="text-primary">Employer sweep:</strong>{" "}
              {employerSweep.checked} / {employerSweep.totalEligible} checked · {employerSweep.remaining} remaining
            </p>
          )}

          {coverage && (
            <p className="text-secondary">
              <strong className="text-primary">Coverage:</strong>{" "}
              {coverage.sourceCandidates} candidates · {coverage.registryMatched} matched · {coverage.boardMatched}/{coverage.boardSampled} official boards
            </p>
          )}

          {coverageError && (
            <p className="text-critical">Sync notice: {coverageError}</p>
          )}
        </div>
      </details>
    </section>
  );
}
