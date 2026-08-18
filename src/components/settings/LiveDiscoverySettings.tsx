"use client";

import { useCallback, useEffect, useState } from "react";

type ScheduleState = {
  configured?: boolean;
  scheduled?: boolean;
  missing?: string[];
  scheduleId?: string;
  cron?: string;
  destination?: string;
  schedule?: {
    scheduleId?: string;
    cron?: string;
    destination?: string;
    isPaused?: boolean;
    lastScheduleTime?: number;
    nextScheduleTime?: number;
  };
  error?: string;
};

function formatTime(value?: number) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export default function LiveDiscoverySettings() {
  const [state, setState] = useState<ScheduleState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const response = await fetch("/api/system/live-discovery/schedule", { cache: "no-store" });
    const data = (await response.json().catch(() => ({}))) as ScheduleState;
    if (!response.ok) setError(data.error ?? "Could not load live-discovery scheduler status.");
    setState(data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/system/live-discovery/schedule", { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as ScheduleState;
      if (!response.ok) {
        setError(data.error ?? "Could not enable live discovery.");
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/system/live-discovery/schedule", { method: "DELETE" });
      const data = (await response.json().catch(() => ({}))) as ScheduleState;
      if (!response.ok) {
        setError(data.error ?? "Could not disable live discovery.");
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  const schedule = state?.schedule;
  const scheduled = state?.scheduled === true;
  const configured = state?.configured !== false;

  return (
    <section className="mt-8 rounded-xl border border-hairline bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-primary">Live internship discovery</h2>
          <p className="mt-1 max-w-2xl text-sm text-secondary">
            Checks fresh internship radar signals and due employer ATS boards every 5 minutes, even when nobody has Discover open.
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            scheduled
              ? "bg-emerald-500/10 text-emerald-500"
              : "bg-amber-500/10 text-amber-500"
          }`}
        >
          {scheduled ? "Live" : "Not scheduled"}
        </span>
      </div>

      {!configured && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-secondary">
          Add <code className="text-primary">QSTASH_TOKEN</code> to the Vercel Production environment, then redeploy. Missing: {(state?.missing ?? []).join(", ") || "QSTASH_TOKEN"}.
        </div>
      )}

      {scheduled && (
        <div className="mt-4 grid gap-2 text-sm text-secondary sm:grid-cols-2">
          <div><span className="text-tertiary">Cadence:</span> {schedule?.cron ?? state?.cron ?? "*/5 * * * *"}</div>
          <div><span className="text-tertiary">Paused:</span> {schedule?.isPaused ? "Yes" : "No"}</div>
          <div><span className="text-tertiary">Last trigger:</span> {formatTime(schedule?.lastScheduleTime)}</div>
          <div><span className="text-tertiary">Next trigger:</span> {formatTime(schedule?.nextScheduleTime)}</div>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-500">
          {error}
        </div>
      )}

      <div className="mt-4 flex gap-3">
        {scheduled ? (
          <button
            type="button"
            disabled={busy}
            onClick={disable}
            className="rounded-lg border border-hairline px-3 py-2 text-sm font-medium text-primary disabled:opacity-40"
          >
            {busy ? "Updating…" : "Disable live discovery"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || !configured}
            onClick={enable}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? "Enabling…" : "Enable 5-minute live discovery"}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void load()}
          className="rounded-lg border border-hairline px-3 py-2 text-sm text-secondary disabled:opacity-40"
        >
          Refresh status
        </button>
      </div>
    </section>
  );
}
