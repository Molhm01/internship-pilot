"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Entry = {
  id: string;
  jobId: string | null;
  company: string;
  jobTitle: string | null;
  provider: string | null;
  duration: string | null;
  link: string | null;
  instructions: string | null;
  legitimacyNotes: string | null;
  createdAt: string;
};

export default function AssessmentsPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * This used to be `await res.json()` with nothing around it. A response that
   * is not JSON — an empty body, or the HTML of a sign-in redirect when the
   * session lapses mid-navigation — threw an unhandled rejection, and because
   * `setLoading(false)` came after it, the page then span on "Loading…"
   * forever. The authenticated browser gate caught exactly that.
   */
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/assessments", { headers: { accept: "application/json" } });
      const body = await res.text();
      if (!res.ok) throw new Error(`Assessments request failed (HTTP ${res.status}).`);
      const data = body ? (JSON.parse(body) as { entries?: Entry[] }) : {};
      setEntries(data.entries ?? []);
      setError(null);
    } catch {
      setEntries([]);
      setError("Assessments could not be loaded. Reload the page to try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="max-w-4xl mx-auto px-8 py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Assessment Inbox</h1>
        <p className="text-secondary text-sm">
          Assessments detected in your Gmail (once connected on the{" "}
          <Link href="/documents" className="text-accent-text hover:underline">
            Documents page
          </Link>
          ).
        </p>
        <div className="mt-3 text-sm bg-caution-quiet border border-caution-line text-caution rounded-lg px-4 py-3">
          This app will never take, solve, or submit a hiring assessment for you. It only detects,
          summarizes, and reminds — completing the assessment yourself, on the real provider&apos;s
          site, is always required.
        </div>
      </header>

      {loading ? (
        <p className="text-sm text-tertiary">Loading…</p>
      ) : error ? (
        <p className="text-sm text-caution">{error}</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-tertiary">No assessments detected yet.</p>
      ) : (
        <div className="space-y-4">
          {entries.map((e) => (
            <div key={e.id} className="bg-surface rounded-lg border border-hairline p-5 space-y-2">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium text-primary">
                    {e.company}
                    {e.jobTitle && ` — ${e.jobTitle}`}
                  </p>
                  {e.provider && <p className="text-xs text-tertiary">Provider: {e.provider}</p>}
                </div>
                {e.jobId && (
                  <Link href={`/jobs/${e.jobId}`} className="text-xs text-accent-text hover:underline">
                    View job ↗
                  </Link>
                )}
              </div>
              {e.duration && <p className="text-sm text-secondary">Duration: {e.duration}</p>}
              {e.instructions && <p className="text-sm text-secondary">{e.instructions}</p>}
              {e.legitimacyNotes && <p className="text-xs text-faint">{e.legitimacyNotes}</p>}
              {e.link && (
                <a href={e.link} target="_blank" rel="noopener noreferrer" className="text-sm text-accent-text hover:underline inline-block">
                  Open assessment link ↗
                </a>
              )}
              <p className="text-xs text-faint">Detected {new Date(e.createdAt).toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
