"use client";

import { useCallback, useEffect, useState } from "react";

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

type Health = { paused: boolean; ticks: Record<string, TickInfo> };

export default function SchedulerHealthPanel() {
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/scheduler/status");
    if (res.ok) setHealth(await res.json());
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  async function togglePause() {
    setBusy(true);
    try {
      await fetch(health?.paused ? "/api/scheduler/resume" : "/api/scheduler/pause", { method: "POST" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!health) return null;

  return (
    <details className="rounded-lg border border-hairline bg-surface p-4 shadow-raised">
      <summary className="flex cursor-pointer items-center justify-between text-small font-medium text-secondary">
        <span>
          Scheduler &amp; Crawler Health{" "}
          <span className={health.paused ? "text-caution" : "text-positive"}>
            ({health.paused ? "Paused" : "Active"})
          </span>
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            togglePause();
          }}
          disabled={busy}
          className="inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-md border border-line bg-canvas px-3 text-micro font-medium text-primary hover:bg-n-50 disabled:opacity-45"
        >
          {busy ? "…" : health.paused ? "Resume" : "Pause"}
        </button>
      </summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {Object.entries(health.ticks).map(([key, tick]) => (
          <div key={key} className="rounded-md border border-hairline bg-canvas/50 p-3 text-micro">
            <p className="font-medium text-primary">{tick.label}</p>
            <p className="text-tertiary">
              Last tick: {tick.lastRunAt ? new Date(tick.lastRunAt).toLocaleString() : "never"}
            </p>
            <p className="text-tertiary">
              Next tick: {tick.nextRunAt ? new Date(tick.nextRunAt).toLocaleString() : "—"}
            </p>
            {tick.lastSummary && (
              <p className={tick.lastStatus === "error" ? "text-critical" : "text-tertiary"}>{tick.lastSummary}</p>
            )}
            <p className="text-faint tabular font-mono">
              New jobs: {tick.newJobsTotal} · Errors: {tick.errorsTotal}
            </p>
          </div>
        ))}
      </div>
    </details>
  );
}
