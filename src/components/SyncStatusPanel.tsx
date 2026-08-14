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

export default function SyncStatusPanel({ onSynced }: { onSynced: () => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/sync/status");
    if (res.ok) setStatus(await res.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSyncNow() {
    setSyncing(true);
    try {
      await fetch("/api/sync/run", { method: "POST" });
      await load();
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
        {syncing ? "Syncing…" : "Sync Now"}
      </button>
    </section>
  );
}
