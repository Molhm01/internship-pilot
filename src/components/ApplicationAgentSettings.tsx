"use client";

import { useCallback, useEffect, useState } from "react";

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
      <h2 className="font-medium text-primary">Application Agent</h2>
      <p className="text-xs text-tertiary">
        Controls whether the agent may fill application forms on official employer pages. It never
        clicks Submit, bypasses CAPTCHAs, or guesses citizenship, sponsorship, clearance, or
        demographic answers.
      </p>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-secondary">Mode</span>
        <select
          value={settings.mode}
          onChange={(event) => void save(event.target.value as Settings["mode"])}
          className="input"
          disabled={saving}
        >
          <option value="OFF">Off - the agent never touches an application form</option>
          <option value="FILL_TO_SUBMIT">Fill To Submit - fills the form, then you review and submit</option>
        </select>
      </label>
      <p className="text-xs text-verified bg-verified-quiet border border-verified-line rounded-lg px-3 py-2">
        AUTO_SUBMIT is permanently disabled. Every completed form stops at final review for you.
      </p>
    </section>
  );
}
