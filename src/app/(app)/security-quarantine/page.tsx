"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type QuarantineEntry = { id: string; reason: string; detail: string; detectedAt: string };
type Job = {
  id: string;
  title: string;
  company: string;
  quarantineEntries: QuarantineEntry[];
};

export default function SecurityQuarantinePage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch("/api/security-quarantine");
    const data = await res.json();
    setJobs(data.jobs ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="max-w-4xl mx-auto px-8 py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Security Quarantine</h1>
        <p className="text-secondary text-sm">
          Postings flagged by fraud protection. Never shown as a normal job, never autofilled, and
          your resume/personal data is never uploaded to any of these.
        </p>
      </header>

      {loading ? (
        <p className="text-sm text-tertiary">Loading…</p>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-tertiary">Nothing quarantined.</p>
      ) : (
        <div className="space-y-4">
          {jobs.map((j) => (
            <div key={j.id} className="bg-surface rounded-lg border border-critical-line p-5 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-primary">{j.title}</p>
                  <p className="text-sm text-secondary">{j.company}</p>
                </div>
                <Link href={`/jobs/${j.id}`} className="text-xs text-accent-text hover:underline">
                  View ↗
                </Link>
              </div>
              <ul className="space-y-1">
                {j.quarantineEntries.map((e) => (
                  <li key={e.id} className="text-xs text-critical bg-critical-quiet border border-critical-line rounded-lg px-3 py-2">
                    <span className="font-semibold">{e.reason}: </span>
                    {e.detail}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
