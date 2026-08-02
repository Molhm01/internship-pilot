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

  const load = useCallback(async () => {
    const res = await fetch("/api/assessments");
    const data = await res.json();
    setEntries(data.entries ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="max-w-4xl mx-auto px-8 py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Assessment Inbox</h1>
        <p className="text-slate-600 text-sm">
          Assessments detected in your Gmail (once connected on the{" "}
          <Link href="/documents" className="text-brand hover:underline">
            Documents page
          </Link>
          ).
        </p>
        <div className="mt-3 text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3">
          This app will never take, solve, or submit a hiring assessment for you. It only detects,
          summarizes, and reminds — completing the assessment yourself, on the real provider&apos;s
          site, is always required.
        </div>
      </header>

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-slate-500">No assessments detected yet.</p>
      ) : (
        <div className="space-y-4">
          {entries.map((e) => (
            <div key={e.id} className="bg-white rounded-xl border border-slate-200 p-5 space-y-2">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium text-slate-900">
                    {e.company}
                    {e.jobTitle && ` — ${e.jobTitle}`}
                  </p>
                  {e.provider && <p className="text-xs text-slate-500">Provider: {e.provider}</p>}
                </div>
                {e.jobId && (
                  <Link href={`/jobs/${e.jobId}`} className="text-xs text-brand hover:underline">
                    View job ↗
                  </Link>
                )}
              </div>
              {e.duration && <p className="text-sm text-slate-700">Duration: {e.duration}</p>}
              {e.instructions && <p className="text-sm text-slate-700">{e.instructions}</p>}
              {e.legitimacyNotes && <p className="text-xs text-slate-400">{e.legitimacyNotes}</p>}
              {e.link && (
                <a href={e.link} target="_blank" rel="noopener noreferrer" className="text-sm text-brand hover:underline inline-block">
                  Open assessment link ↗
                </a>
              )}
              <p className="text-xs text-slate-400">Detected {new Date(e.createdAt).toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
