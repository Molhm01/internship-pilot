"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type TickInfo = {
  label: string;
  intervalMs: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: "success" | "error" | null;
  lastSummary: string | null;
  newJobsTotal: number;
  errorsTotal: number;
};

type Health = { paused: boolean; ticks: Record<string, TickInfo>; computedAt?: string };

// Database-usage remediation (see DATABASE EFFICIENCY REPAIR): this panel used
// to poll /api/scheduler/status every 30 seconds in every open tab regardless
// of visibility. It now polls at most every 5 minutes, only while visible,
// and the endpoint itself is backed by a short-TTL server cache (see
// getCachedSchedulerHealth in src/lib/sync/schedulerState.ts).
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const STALE_ON_VISIBLE_AFTER_MS = POLL_INTERVAL_MS;

export default function SchedulerHealthPanel() {
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const lastFetchedAt = useRef(0);

  const load = useCallback(async (options: { force?: boolean } = {}) => {
    const res = await fetch(options.force ? "/api/scheduler/status?fresh=1" : "/api/scheduler/status");
    if (res.ok) {
      setHealth(await res.json());
      lastFetchedAt.current = Date.now();
    }
  }, []);

  useEffect(() => {
    let interval: number | null = null;

    const startPolling = () => {
      if (interval !== null) return;
      interval = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    };
    const stopPolling = () => {
      if (interval === null) return;
      window.clearInterval(interval);
      interval = null;
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        stopPolling();
        return;
      }
      startPolling();
      const staleForMs = Date.now() - lastFetchedAt.current;
      if (lastFetchedAt.current === 0 || staleForMs >= STALE_ON_VISIBLE_AFTER_MS) {
        void load();
      }
    };

    if (document.visibilityState === "visible") {
      void load();
      startPolling();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [load]);

  async function togglePause() {
    setBusy(true);
    try {
      await fetch(health?.paused ? "/api/scheduler/resume" : "/api/scheduler/pause", { method: "POST" });
      await load({ force: true });
    } finally {
      setBusy(false);
    }
  }

  if (!health) return null;

  return (
    <details className="bg-surface rounded-lg border border-hairline p-4">
      <summary className="cursor-pointer flex items-center justify-between text-sm font-medium text-secondary">
        <span>
          Monitoring control{" "}
          <span className={health.paused ? "text-amber-600" : "text-emerald-600"}>
            ({health.paused ? "Paused" : "Enabled"})
          </span>
        </span>
        <button
          onClick={(e) => {
            e.preventDefault();
            togglePause();
          }}
          disabled={busy}
          className="rounded-lg border border-line text-xs font-medium px-3 py-1.5 hover:bg-sunken disabled:opacity-40"
        >
          {busy ? "…" : health.paused ? "Resume Monitoring" : "Pause Monitoring"}
        </button>
      </summary>
      <p className="mt-3 text-xs text-tertiary">
        This switch only controls whether scheduled ingestion is allowed to run. It does not prove the external scheduler is firing; the real hosted-sync health is shown above.
        {health.computedAt && ` Status as of ${new Date(health.computedAt).toLocaleTimeString()}.`}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {Object.entries(health.ticks).map(([key, tick]) => (
          <div key={key} className="rounded-lg border border-hairline p-3 text-xs">
            <p className="font-medium text-secondary">{tick.label}</p>
            <p className="text-tertiary">
              Last local tick: {tick.lastRunAt ? new Date(tick.lastRunAt).toLocaleString() : "never"}
            </p>
            <p className="text-tertiary">
              Next local tick: {tick.nextRunAt ? new Date(tick.nextRunAt).toLocaleString() : "—"}
            </p>
            {tick.lastSummary && (
              <p className={tick.lastStatus === "error" ? "text-rose-600" : "text-tertiary"}>{tick.lastSummary}</p>
            )}
            <p className="text-faint">
              New jobs total: {tick.newJobsTotal} · Errors total: {tick.errorsTotal}
            </p>
          </div>
        ))}
      </div>
    </details>
  );
}
