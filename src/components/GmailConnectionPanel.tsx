"use client";

import { useCallback, useEffect, useState } from "react";

type Status = { connected: boolean; emailAddress?: string; lastSyncAt?: string | null; configured: boolean };

export default function GmailConnectionPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/gmail/status");
    setStatus(await res.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function disconnect() {
    if (!confirm("Disconnect Gmail? Tracked email history stays, but automatic tracker updates from email will stop.")) return;
    await fetch("/api/gmail/disconnect", { method: "POST" });
    await load();
  }

  async function syncNow() {
    setSyncing(true);
    try {
      await fetch("/api/gmail/sync", { method: "POST" });
      await load();
    } finally {
      setSyncing(false);
    }
  }

  if (!status) return null;

  return (
    <section className="bg-white rounded-xl border border-slate-200 p-6 space-y-3">
      <h2 className="font-medium text-slate-900">Gmail Application Tracking</h2>
      <p className="text-xs text-slate-500">
        Read-only access only — this app never sends, deletes, archives, or modifies anything in
        your mailbox, and never stores your password. Checks every 5 minutes for confirmations,
        assessments, interview requests, and rejections, and updates the Tracker automatically.
      </p>

      {!status.configured && (
        <div className="text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3">
          Not set up yet — this requires your own free Google Cloud OAuth client. See SETUP.md for
          step-by-step instructions, then set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env and
          restart the app.
        </div>
      )}

      {status.configured && !status.connected && (
        <a
          href="/api/gmail/auth/start"
          className="inline-block rounded-lg bg-brand text-white text-sm font-medium px-4 py-2.5 hover:bg-brand-dark transition-colors"
        >
          Connect Gmail
        </a>
      )}

      {status.connected && (
        <div className="space-y-2">
          <p className="text-sm text-slate-700">
            Connected as <span className="font-medium">{status.emailAddress}</span>
          </p>
          <p className="text-xs text-slate-400">
            {status.lastSyncAt ? `Last checked ${new Date(status.lastSyncAt).toLocaleString()}` : "Not synced yet"}
          </p>
          <div className="flex gap-3">
            <button
              onClick={syncNow}
              disabled={syncing}
              className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2 disabled:opacity-40 hover:bg-brand-dark transition-colors"
            >
              {syncing ? "Checking…" : "Check now"}
            </button>
            <button onClick={disconnect} className="text-sm text-rose-600 hover:underline">
              Disconnect
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
