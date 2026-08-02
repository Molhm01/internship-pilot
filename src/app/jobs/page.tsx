"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import JobCard, { JobCardData } from "@/components/JobCard";
import SyncStatusPanel from "@/components/SyncStatusPanel";
import SchedulerHealthPanel from "@/components/SchedulerHealthPanel";
import JobFilters, { buildJobsQuery, EMPTY_FILTERS, JobFiltersState } from "@/components/JobFilters";
import {
  fetchJobCounts,
  fetchJobsPage,
  JOBS_LIST_ENDPOINT,
  jobsListViewState,
} from "@/lib/jobs/jobsApi";
import {
  fetchBulkScoreStatus,
  runBulkScoreScheduling,
  startBulkScoreStatusPolling,
} from "@/lib/matching/bulkScoreClient";
import type { BulkInitialMatchStatus } from "@/lib/matching/bulkInitialMatch";
import {
  applyJobSort,
  DEFAULT_JOB_SORT,
  JOB_SORT_LABELS,
  JOB_SORT_OPTIONS,
  parseJobSort,
  type JobSort,
} from "@/lib/jobs/jobSort";

const emptyForm = {
  title: "",
  company: "",
  location: "",
  postingDate: "",
  internshipTerm: "",
  duration: "",
  url: "",
  description: "",
};

type JobCounts = {
  active: number;
  officiallyVerified: number;
  sourceListed: number;
  verificationPending: number;
  closedConfirmed: number;
  securityBlocked: number;
  scored: number;
  unscored: number;
  scoring: number;
  eligibilityPass: number;
  eligibilityFail: number;
  total: number;
};

const PAGE_SIZE = 60;

// useSearchParams makes this subtree client-rendered, so it must sit inside a
// Suspense boundary for the rest of the route to prerender (Next.js App Router
// requirement, see docs/01-app/.../use-search-params.md).
export default function JobsPage() {
  return (
    <Suspense fallback={<p className="max-w-5xl mx-auto px-8 py-10 text-sm text-slate-500">Loading…</p>}>
      <JobsPageContent />
    </Suspense>
  );
}

function JobsPageContent() {
  const [jobs, setJobs] = useState<JobCardData[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [filters, setFilters] = useState<JobFiltersState>(EMPTY_FILTERS);
  const [counts, setCounts] = useState<JobCounts | null>(null);
  const [countsError, setCountsError] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [bulkQueueing, setBulkQueueing] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkStatus, setBulkStatus] = useState<BulkInitialMatchStatus | null>(null);
  const lastSettledCount = useRef<number | null>(null);

  // The selected sort lives in the URL, not in component state, so it survives
  // a reload, a shared link, and a back/forward navigation. Filters live in
  // React state and are rebuilt on every change — the sort is applied on top of
  // whatever query they produce, so changing a filter never resets it.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const sort: JobSort = parseJobSort(searchParams.get("sort"));

  const setSort = useCallback((next: JobSort) => {
    const params = new URLSearchParams(searchParams.toString());
    applyJobSort(params, next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  const queryFor = useMemo(() => (offset: number) => {
    const params = applyJobSort(buildJobsQuery(filters), sort);
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(offset));
    return params;
  }, [filters, sort]);

  const loadCounts = useCallback(async () => {
    setCountsError(null);
    try {
      setCounts(await fetchJobCounts<JobCounts>());
    } catch (error) {
      setCounts(null);
      setCountsError(error instanceof Error ? error.message : "Failed to load job counts.");
    }
  }, []);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const data = await fetchJobsPage<JobCardData>(queryFor(0));
      const uniqueJobs = Array.from(
        new Map(data.jobs.map((job) => [job.id, job])).values()
      ) as JobCardData[];
      setJobs(uniqueJobs);
      setTotal(data.total);
    } catch (err) {
      setJobs([]);
      setTotal(0);
      setFetchError(err instanceof Error ? err.message : "Failed to load jobs.");
    } finally {
      setLoading(false);
    }
  }, [queryFor]);

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    setFetchError(null);
    try {
      // Paging keeps the SAME sort — the next page is the next slice of one
      // consistent order, never a differently-ordered batch appended on top.
      const data = await fetchJobsPage<JobCardData>(queryFor(jobs.length));
      const fetched = data.jobs;
      setJobs((prev) =>
        Array.from(new Map([...prev, ...fetched].map((j) => [j.id, j])).values())
      );
      setTotal(data.total);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to load more jobs.");
    } finally {
      setLoadingMore(false);
    }
  }, [jobs.length, loadingMore, queryFor]);

  const applyBulkStatus = useCallback((status: BulkInitialMatchStatus) => {
    const settled = status.completed + status.failed;
    const changed = lastSettledCount.current !== null && lastSettledCount.current !== settled;
    lastSettledCount.current = settled;
    setBulkStatus(status);
    if (changed) void Promise.all([loadJobs(), loadCounts()]);
  }, [loadCounts, loadJobs]);

  const refreshBulkStatus = useCallback(async () => {
    const status = await fetchBulkScoreStatus();
    applyBulkStatus(status);
    return status;
  }, [applyBulkStatus]);

  useEffect(() => {
    loadJobs();
    loadCounts();
  }, [loadJobs, loadCounts]);

  useEffect(() => {
    void refreshBulkStatus().catch((error) => {
      setBulkError(error instanceof Error ? error.message : "Scoring progress is unavailable.");
    });
  }, [refreshBulkStatus]);

  useEffect(() => {
    if (!bulkStatus || (bulkStatus.queued === 0 && bulkStatus.running === 0)) return;
    return startBulkScoreStatusPolling({
      fetchStatus: fetchBulkScoreStatus,
      onStatus: applyBulkStatus,
      onError: setBulkError,
    });
  }, [applyBulkStatus, bulkStatus]);

  const handleScoreAllUnscored = useCallback(async () => {
    setBulkError(null);
    setBulkMessage(null);
    await runBulkScoreScheduling({
      setScheduling: setBulkQueueing,
      onSuccess: (result) => {
        setBulkMessage(`Queued ${result.queued} jobs for scoring.`);
        void Promise.all([refreshBulkStatus(), loadCounts()]).catch((error) => {
          setBulkError(error instanceof Error ? error.message : "Scoring progress is unavailable.");
        });
      },
      onError: setBulkError,
    });
  }, [loadCounts, refreshBulkStatus]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await fetch(JOBS_LIST_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error ?? "Could not save job.");
        return;
      }
      setForm(emptyForm);
      setShowForm(false);
      await Promise.all([loadJobs(), loadCounts()]);
    } finally {
      setSubmitting(false);
    }
  }

  const viewState = jobsListViewState({
    loading,
    error: fetchError,
    jobCount: jobs.length,
  });

  return (
    <div className="max-w-5xl mx-auto px-8 py-10 space-y-6">
      <header className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Jobs</h1>
          <p className="text-slate-600 text-sm">
            Every legitimate discovered internship appears here in one feed — officially verified,
            source listed, and verification pending — ordered by when the source says it was posted,
            newest first. A missing Greenhouse/Lever/Ashby mirror never hides or closes a job, and
            scoring or verification state never moves an older posting above a newer one; each card
            carries an availability badge instead.
          </p>
        </div>
        {counts && (
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
            <CountTile label="Active jobs" value={counts.active} tone="brand" />
            <CountTile label="Officially verified" value={counts.officiallyVerified} tone="emerald" />
            <CountTile label="Source listed" value={counts.sourceListed} tone="sky" />
            <CountTile label="Verification pending" value={counts.verificationPending} tone="amber" />
            <CountTile label="Scored" value={counts.scored} tone="brand" />
            <CountTile label="Unscored" value={counts.unscored} tone="amber" />
            <CountTile label="Scoring" value={counts.scoring} tone="sky" />
            <CountTile label="Eligibility Pass" value={counts.eligibilityPass} tone="emerald" />
            <CountTile label="Eligibility Fail" value={counts.eligibilityFail} tone="rose" />
            <CountTile label="Closed confirmed" value={counts.closedConfirmed} tone="rose" />
            <CountTile label="Security blocked" value={counts.securityBlocked} tone="rose" />
          </div>
        )}
        {countsError && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Job summary unavailable: {countsError}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
            Sort by
            <select
              value={sort}
              onChange={(e) => setSort(parseJobSort(e.target.value))}
              data-testid="jobs-sort"
              className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-700"
            >
              {JOB_SORT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {JOB_SORT_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          {sort !== DEFAULT_JOB_SORT && (
            <button
              onClick={() => setSort(DEFAULT_JOB_SORT)}
              className="px-3 py-1.5 bg-slate-100 text-slate-700 font-medium text-xs rounded-lg hover:bg-slate-200 transition-colors"
            >
              Back to newest posted
            </button>
          )}
          <button
            onClick={() => void handleScoreAllUnscored()}
            disabled={bulkQueueing}
            className="px-3 py-1.5 bg-brand text-white font-medium text-xs rounded-lg hover:bg-brand-dark disabled:opacity-50 transition-colors"
          >
            {bulkQueueing ? "Queuing jobs..." : "Score all unscored jobs"}
          </button>
          <button
            onClick={() => {
              setFilters(EMPTY_FILTERS);
            }}
            className="px-3 py-1.5 bg-slate-100 text-slate-700 font-medium text-xs rounded-lg hover:bg-slate-200 transition-colors"
          >
            Clear All Filters
          </button>
        </div>
        {bulkMessage && (
          <p className="text-sm text-emerald-700" role="status">{bulkMessage}</p>
        )}
        {bulkError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert">
            {bulkError}
          </div>
        )}
        {bulkStatus && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2" aria-label="AI Match queue progress">
            <CountTile label="Total unscored" value={bulkStatus.totalUnscored} tone="amber" />
            <CountTile label="Queued" value={bulkStatus.queued} tone="sky" />
            <CountTile label="Running" value={bulkStatus.running} tone="brand" />
            <CountTile label="Completed" value={bulkStatus.completed} tone="emerald" />
            <CountTile label="Failed" value={bulkStatus.failed} tone="rose" />
          </div>
        )}
      </header>

      <SyncStatusPanel onSynced={loadJobs} />
      <SchedulerHealthPanel />

      <JobFilters filters={filters} onChange={setFilters} />

      <div className="flex justify-end">
        <button
          onClick={() => setShowForm((v) => !v)}
          className="text-sm text-slate-500 hover:text-brand underline"
        >
          {showForm ? "Close manual entry form" : "+ Manually add a job (e.g. from a site we don't sync)"}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-xl border border-slate-200 p-6 space-y-4"
        >
          <div className="grid grid-cols-2 gap-4">
            <Field label="Job title *">
              <input
                required
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="input"
              />
            </Field>
            <Field label="Company *">
              <input
                required
                value={form.company}
                onChange={(e) => setForm({ ...form, company: e.target.value })}
                className="input"
              />
            </Field>
            <Field label="Location">
              <input
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                className="input"
                placeholder="e.g. Remote, New York NY"
              />
            </Field>
            <Field label="Posting date">
              <input
                type="date"
                value={form.postingDate}
                onChange={(e) => setForm({ ...form, postingDate: e.target.value })}
                className="input"
              />
            </Field>
            <Field label="Internship term">
              <input
                value={form.internshipTerm}
                onChange={(e) => setForm({ ...form, internshipTerm: e.target.value })}
                className="input"
                placeholder="e.g. Summer 2027"
              />
            </Field>
            <Field label="Duration">
              <input
                value={form.duration}
                onChange={(e) => setForm({ ...form, duration: e.target.value })}
                className="input"
                placeholder="e.g. 10 weeks"
              />
            </Field>
            <Field label="Official URL" full>
              <input
                type="url"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                className="input"
                placeholder="https://…"
              />
            </Field>
          </div>
          <Field label="Full job description *">
            <textarea
              required
              rows={8}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="input"
              placeholder="Paste the complete job description here…"
            />
          </Field>
          {formError && (
            <div className="rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-3">
              {formError}
            </div>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2.5 disabled:opacity-40 hover:bg-brand-dark transition-colors"
          >
            {submitting ? "Saving…" : "Save job"}
          </button>
        </form>
      )}

      {fetchError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-800 text-sm flex items-center justify-between gap-4">
          <span>{fetchError}</span>
          <button
            onClick={() => void loadJobs()}
            className="px-3 py-1.5 bg-rose-600 text-white rounded-lg text-xs font-semibold hover:bg-rose-700 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {viewState === "loading" ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : viewState === "error" ? null : viewState === "empty" ? (
        <p className="text-sm text-slate-500">
          Jobs loaded successfully, but no jobs match these filters. Try Sync Now, or loosen the filters above.
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-500" data-testid="results-count">
            Showing <span className="font-medium text-slate-700">{jobs.length}</span> of{" "}
            <span className="font-medium text-slate-700">{total}</span> matching jobs
          </p>
          <div className="grid grid-cols-2 gap-4">
            {jobs.map((job) => (
              <JobCard key={job.id} job={job} />
            ))}
          </div>
          {jobs.length < total && (
            <div className="flex justify-center pt-2">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="rounded-lg border border-slate-300 bg-white text-sm font-medium px-5 py-2.5 disabled:opacity-40 hover:border-brand/50"
              >
                {loadingMore ? "Loading…" : `Load more (${total - jobs.length} remaining)`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CountTile({ label, value, tone }: { label: string; value: number; tone: "brand" | "emerald" | "sky" | "amber" | "rose" }) {
  const tones: Record<string, string> = {
    brand: "border-brand/40 bg-brand/5",
    emerald: "border-emerald-200 bg-emerald-50",
    sky: "border-sky-200 bg-sky-50",
    amber: "border-amber-200 bg-amber-50",
    rose: "border-rose-200 bg-rose-50",
  };
  return (
    <div className={`rounded-lg border p-3 ${tones[tone]}`}>
      <div className="text-xl font-semibold text-slate-800">{value}</div>
      <div className="text-[11px] text-slate-600 leading-tight">{label}</div>
    </div>
  );
}

function Field({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <label className={`block space-y-1 ${full ? "col-span-2" : ""}`}>
      <span className="text-xs font-medium text-slate-600">{label}</span>
      {children}
    </label>
  );
}
