"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import StatusSelector from "@/components/StatusSelector";
import MatchScoreBadge from "@/components/MatchScoreBadge";
import { STATUS_COLORS, TRACKER_STATUSES, TrackerStatus } from "@/lib/statuses";

type TrackerJob = {
  id: string;
  title: string;
  company: string;
  status: string;
  matchResults?: { score: number; eligibility: string }[];
};

export default function TrackerPage() {
  const [jobs, setJobs] = useState<TrackerJob[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch("/api/jobs");
    const data = await res.json();
    setJobs(data.jobs ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function moveJob(jobId: string, status: string) {
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status } : j)));
    await fetch(`/api/jobs/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  }

  const columns: Record<TrackerStatus, TrackerJob[]> = Object.fromEntries(
    TRACKER_STATUSES.map((s) => [s, jobs.filter((j) => j.status === s)]),
  ) as Record<TrackerStatus, TrackerJob[]>;

  return (
    <div className="px-8 py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Tracker</h1>
        <p className="text-slate-600 text-sm">
          Move each application through its stages. Changes save automatically.
        </p>
      </header>

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {TRACKER_STATUSES.map((status) => (
            <div key={status} className="w-72 shrink-0">
              <div
                className={`rounded-t-xl border px-3 py-2 text-sm font-semibold ${STATUS_COLORS[status]}`}
              >
                {status} ({columns[status].length})
              </div>
              <div className="border border-t-0 border-slate-200 rounded-b-xl bg-slate-50 p-2 space-y-2 min-h-[120px]">
                {columns[status].length === 0 ? (
                  <p className="text-xs text-slate-400 text-center py-4">Empty</p>
                ) : (
                  columns[status].map((job) => (
                    <div key={job.id} className="bg-white rounded-lg border border-slate-200 p-3 space-y-2">
                      <Link href={`/jobs/${job.id}`} className="block">
                        <p className="text-sm font-medium text-slate-900 truncate hover:text-brand">
                          {job.title}
                        </p>
                        <p className="text-xs text-slate-500 truncate">{job.company}</p>
                      </Link>
                      {job.matchResults?.[0] && (
                        <MatchScoreBadge
                          score={job.matchResults[0].score}
                          eligibility={job.matchResults[0].eligibility}
                        />
                      )}
                      <StatusSelector value={job.status} onChange={(s) => moveJob(job.id, s)} />
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
