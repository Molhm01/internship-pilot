"use client";

import { useCallback, useEffect, useState } from "react";

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

export default function SyncStatusPanel({ onSynced }: { onSynced: () => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [coverage, setCoverage] = useState<CoverageDiagnostics | null>(null);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [employerSweep, setEmployerSweep] = useState<EmployerSweepSummary | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/sync/status");
    if (res.ok) setStatus(await res.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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

      await Promise.all([load(), loadCoverageDiagnostics()]);
      onSynced();
    } finally {
      setSyncing(false);
    }
  }

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
        disabled={syncing}
        className="rounded-lg bg-accent text-white text-sm font-medium px-4 py-2 disabled:opacity-40 hover:bg-accent-dark transition-colors shrink-0"
      >
        {syncing ? "Sweeping employers…" : "Sync Now"}
      </button>

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
          Coverage diagnostic error: {coverageError}
        </div>
      )}
    </section>
  );
}
