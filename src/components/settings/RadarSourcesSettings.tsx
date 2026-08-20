"use client";

import { useCallback, useEffect, useState } from "react";

const PROVIDERS = [
  ["linkedin", "LinkedIn"],
  ["handshake", "Handshake"],
  ["indeed", "Indeed"],
  ["glassdoor", "Glassdoor"],
  ["ziprecruiter", "ZipRecruiter"],
] as const;

type ProviderState = {
  detectedEmails: number;
  signalsExtracted: number;
  signalsEnqueued: number;
  lastSeenAt: string | null;
};

type RadarStatus = {
  ok: boolean;
  lastLiveRun: { finishedAt: string | null; newJobs: number; updatedJobs: number } | null;
  sources: {
    jobright: {
      lastCheckedAt?: string;
      sourceFresh?: number;
      freshUnder24h?: number;
      freshUnder72h?: number;
      categoryCounts?: Record<string, number>;
    } | null;
    internList: {
      lastCheckedAt: string;
      jobsSeen: number;
      pagesFetched: number;
      pagesFailed: number;
      maxPagesReached: boolean;
      maxJobsReached: boolean;
    } | null;
    directPublicFeeds: {
      lastCheckedAt?: string;
      recentCandidates?: number;
      sourceCounts?: Record<string, number>;
    } | null;
    gmail: {
      connected: boolean;
      emailAddress: string | null;
      lastSyncAt: string | null;
      providers: Record<string, ProviderState>;
    };
  };
  queue: {
    pending: number;
    retry: number;
    resolved: number;
    abandoned: number;
  };
};

function when(value?: string | null): string {
  if (!value) return "Not seen yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not seen yet";
  return date.toLocaleString();
}

function SourceRow({
  name,
  status,
  detail,
  lastSeen,
}: {
  name: string;
  status: string;
  detail: string;
  lastSeen?: string | null;
}) {
  return (
    <div className="grid gap-2 border-b border-hairline px-3 py-3 last:border-b-0 sm:grid-cols-[180px_150px_1fr] sm:items-center">
      <div className="text-sm font-medium text-primary">{name}</div>
      <div>
        <span className="inline-flex rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-500">
          {status}
        </span>
      </div>
      <div className="min-w-0">
        <p className="text-xs text-secondary">{detail}</p>
        {lastSeen !== undefined && (
          <p className="mt-0.5 text-[11px] text-tertiary">Last signal: {when(lastSeen)}</p>
        )}
      </div>
    </div>
  );
}

export default function RadarSourcesSettings() {
  const [data, setData] = useState<RadarStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/radar/status", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as RadarStatus | null;
      if (!response.ok || !body?.ok) throw new Error("Radar status could not be loaded.");
      setData(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Radar status could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const gmail = data?.sources.gmail;
  const direct = data?.sources.directPublicFeeds;
  const jobright = data?.sources.jobright;
  const internList = data?.sources.internList;

  return (
    <section className="mt-8 rounded-xl border border-hairline bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-primary">Radar sources</h2>
          <p className="mt-1 max-w-2xl text-sm text-secondary">
            Aggregators are discovery signals only. Internship Pilot resolves a signal to the employer&apos;s official ATS posting before it becomes a Discover job.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-lg border border-hairline px-3 py-2 text-xs text-secondary"
        >
          Refresh radar
        </button>
      </div>

      {loading && <p className="mt-4 text-sm text-tertiary">Loading radar sources…</p>}
      {error && (
        <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-500">
          {error}
        </div>
      )}

      {data && (
        <>
          <div className="mt-4 overflow-hidden rounded-lg border border-hairline">
            <SourceRow
              name="Jobright fresh radar"
              status="Live"
              detail={`${jobright?.sourceFresh ?? 0} fresh technical signals in the last source read · ${jobright?.freshUnder24h ?? 0} under 24h.`}
              lastSeen={jobright?.lastCheckedAt}
            />
            <SourceRow
              name="Intern List depth radar"
              status="Live"
              detail={`${internList?.jobsSeen ?? 0} public listings read across ${internList?.pagesFetched ?? 0} pages in the latest crawl.`}
              lastSeen={internList?.lastCheckedAt}
            />
            <SourceRow
              name="Direct public indexes"
              status="Live"
              detail={`${direct?.recentCandidates ?? 0} recent direct candidates · Simplify ${direct?.sourceCounts?.simplify ?? 0} · Zapply ${direct?.sourceCounts?.zapply ?? 0} · ApplyGuy ${direct?.sourceCounts?.applyguy ?? 0} · Dreamwork ${direct?.sourceCounts?.dreamwork ?? 0}.`}
              lastSeen={direct?.lastCheckedAt}
            />
          </div>

          <div className="mt-5">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-primary">Personal job-alert radars</h3>
                <p className="mt-1 text-xs text-secondary">
                  Create normal job alerts on these services. When Gmail is connected, Internship Pilot reads those alert emails and uses them as radar signals. No LinkedIn, Handshake, Indeed, Glassdoor, or ZipRecruiter password is stored.
                </p>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${gmail?.connected ? "bg-emerald-500/10 text-emerald-500" : "bg-amber-500/10 text-amber-500"}`}>
                {gmail?.connected ? `Gmail connected${gmail.emailAddress ? ` · ${gmail.emailAddress}` : ""}` : "Connect Gmail below"}
              </span>
            </div>

            <div className="mt-3 overflow-hidden rounded-lg border border-hairline">
              {PROVIDERS.map(([key, label]) => {
                const provider = gmail?.providers?.[key];
                const active = gmail?.connected === true;
                return (
                  <div key={key} className="grid gap-2 border-b border-hairline px-3 py-3 last:border-b-0 sm:grid-cols-[180px_150px_1fr] sm:items-center">
                    <div className="text-sm font-medium text-primary">{label}</div>
                    <div>
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${active ? "bg-emerald-500/10 text-emerald-500" : "bg-amber-500/10 text-amber-500"}`}>
                        {active ? "Listening via Gmail" : "Waiting for Gmail"}
                      </span>
                    </div>
                    <div>
                      <p className="text-xs text-secondary">
                        {provider?.signalsExtracted ?? 0} signals detected · {provider?.signalsEnqueued ?? 0} queued for official resolution.
                      </p>
                      <p className="mt-0.5 text-[11px] text-tertiary">Last alert: {when(provider?.lastSeenAt)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-4 grid gap-2 rounded-lg border border-hairline bg-background/40 p-3 text-xs text-secondary sm:grid-cols-4">
            <div><span className="text-tertiary">Radar pending:</span> {data.queue.pending}</div>
            <div><span className="text-tertiary">Retrying:</span> {data.queue.retry}</div>
            <div><span className="text-tertiary">Officially resolved:</span> {data.queue.resolved}</div>
            <div><span className="text-tertiary">Expired/unresolved:</span> {data.queue.abandoned}</div>
          </div>
        </>
      )}
    </section>
  );
}
