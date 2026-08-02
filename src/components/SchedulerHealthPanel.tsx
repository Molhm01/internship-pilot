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
    <details className="bg-white rounded-xl border border-slate-200 p-4">
      <summary className="cursor-pointer flex items-center justify-between text-sm font-medium text-slate-700">
        <span>
          Scheduler health{" "}
          <span className={health.paused ? "text-amber-600" : "text-emerald-600"}>
            ({health.paused ? "Paused" : "Running"})
          </span>
        </span>
        <button
          onClick={(e) => {
            e.preventDefault();
            togglePause();
          }}
          disabled={busy}
          className="rounded-lg border border-slate-300 text-xs font-medium px-3 py-1.5 hover:bg-slate-50 disabled:opacity-40"
        >
          {busy ? "…" : health.paused ? "Resume Monitoring" : "Pause Monitoring"}
        </button>
      </summary>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {Object.entries(health.ticks).map(([key, tick]) => (
          <div key={key} className="rounded-lg border border-slate-100 p-3 text-xs">
            <p className="font-medium text-slate-700">{tick.label}</p>
            <p className="text-slate-500">
              Last run: {tick.lastRunAt ? new Date(tick.lastRunAt).toLocaleString() : "never"}
            </p>
            <p className="text-slate-500">
              Next run: {tick.nextRunAt ? new Date(tick.nextRunAt).toLocaleString() : "—"}
            </p>
            {tick.lastSummary && (
              <p className={tick.lastStatus === "error" ? "text-rose-600" : "text-slate-500"}>{tick.lastSummary}</p>
            )}
            <p className="text-slate-400">
              New jobs total: {tick.newJobsTotal} · Errors total: {tick.errorsTotal}
            </p>
          </div>
        ))}
      </div>
    </details>
  );
}
