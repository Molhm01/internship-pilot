"use client";

import { useCallback, useEffect, useState } from "react";

import Link from "next/link";

type Settings = { mode: "OFF" | "FILL_TO_SUBMIT" };

export default function ApplicationAgentSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/applications/settings");
    setSettings(await response.json());
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save(mode: Settings["mode"]) {
    setSaving(true);
    try {
      const response = await fetch("/api/applications/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      setSettings(await response.json());
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return null;

  return (
    <section className="bg-surface rounded-lg border border-hairline p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-medium text-primary">Application Agent</h2>
        <Link href="/agent" className="text-xs font-medium text-accent-text hover:underline">
          Open Autonomous Agent →
        </Link>
      </div>
      <p className="text-xs text-tertiary">
        Controls browser form-filling on official employer pages. The agent never bypasses CAPTCHAs or
        guesses unstored citizenship, sponsorship, clearance, or demographic answers.
      </p>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-secondary">Interactive Extension Mode</span>
        <select
          value={settings.mode}
          onChange={(event) => void save(event.target.value as Settings["mode"])}
          className="input"
          disabled={saving}
        >
          <option value="OFF">Off - interactive extension will not fill forms</option>
          <option value="FILL_TO_SUBMIT">Fill To Submit - fills the form interactively for your review</option>
        </select>
      </label>
      <p className="text-xs text-verified bg-verified-quiet border border-verified-line rounded-lg px-3 py-2">
        Autonomous Fill &amp; Auto-Submit is enabled for both cloud and local execution in the Autonomous Agent console and on individual job pages.
      </p>
    </section>
  );
}
