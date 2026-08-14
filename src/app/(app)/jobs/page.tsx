"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus, RotateCcw, Sparkles, SlidersHorizontal, X } from "lucide-react";
import { JobCard, type JobCardData } from "@/components/product/JobCard";
import SyncStatusPanel from "@/components/SyncStatusPanel";
import SchedulerHealthPanel from "@/components/SchedulerHealthPanel";
import JobFilters, { buildJobsQuery, EMPTY_FILTERS, JobFiltersState } from "@/components/JobFilters";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { Metric, MetricRow } from "@/components/ui/Metric";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { EmptyState, ErrorState, Notice, SkeletonRows } from "@/components/ui/State";
import { cn } from "@/components/ui/cn";
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
    <Suspense
      fallback={
        <PageBody>
          <SkeletonRows rows={6} />
        </PageBody>
      }
    >
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
  const [showFilters, setShowFilters] = useState(false);
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

  const scoringActive = Boolean(
    bulkStatus && (bulkStatus.queued > 0 || bulkStatus.running > 0),
  );

  return (
    <PageBody>
      <PageHeader
        title="Discover"
        description="Every legitimate discovered internship in one feed, ordered by when the source says it was posted. Availability is carried on each card rather than hiding jobs from the list."
        meta={
          counts && (
            <>
              <span>{counts.total.toLocaleString()} total</span>
              <span>·</span>
              <span>{counts.active.toLocaleString()} active</span>
            </>
          )
        }
        actions={
          <>
            <Button
              size="md"
              onClick={() => setShowFilters((value) => !value)}
              className={cn(showFilters && "border-accent-line text-primary")}
            >
              <SlidersHorizontal className="size-3.5" aria-hidden />
              Filters
            </Button>
            <Button size="md" onClick={() => setShowForm((v) => !v)}>
              <Plus className="size-3.5" aria-hidden />
              Add job
            </Button>
            <Button
              size="md"
              variant="primary"
              onClick={() => void handleScoreAllUnscored()}
              disabled={bulkQueueing}
            >
              <Sparkles
                className={cn("size-3.5", (bulkQueueing || scoringActive) && "animate-agent-pulse")}
                aria-hidden
              />
              {bulkQueueing ? "Queuing…" : "Score unscored"}
            </Button>
          </>
        }
      />

      {/* ------------------------------------------------------- readout */}
      {counts && (
        <Panel flush className="mb-4">
          <MetricRow className="px-4 py-1">
            <Metric label="Active" value={counts.active.toLocaleString()} tone="accent" />
            <Metric label="Verified" value={counts.officiallyVerified.toLocaleString()} tone="positive" />
            <Metric label="Source listed" value={counts.sourceListed.toLocaleString()} tone="info" />
            <Metric label="Pending" value={counts.verificationPending.toLocaleString()} tone="caution" />
            <Metric label="Scored" value={counts.scored.toLocaleString()} />
            <Metric label="Unscored" value={counts.unscored.toLocaleString()} tone="caution" />
            <Metric label="Eligible" value={counts.eligibilityPass.toLocaleString()} tone="positive" />
            <Metric label="Ineligible" value={counts.eligibilityFail.toLocaleString()} tone="critical" />
            <Metric label="Closed" value={counts.closedConfirmed.toLocaleString()} tone="critical" />
            <Metric label="Blocked" value={counts.securityBlocked.toLocaleString()} tone="critical" />
          </MetricRow>
        </Panel>
      )}

      {countsError && (
        <Notice tone="caution" className="mb-4">
          Job summary unavailable: {countsError}
        </Notice>
      )}

      {/* Bulk scoring progress only appears while there is something to report. */}
      {bulkStatus && scoringActive && (
        <Panel flush tone="accent" className="mb-4">
          <MetricRow className="px-4 py-1">
            <Metric label="Unscored" value={bulkStatus.totalUnscored} tone="caution" />
            <Metric label="Queued" value={bulkStatus.queued} tone="info" />
            <Metric label="Running" value={bulkStatus.running} tone="accent" />
            <Metric label="Completed" value={bulkStatus.completed} tone="positive" />
            <Metric label="Failed" value={bulkStatus.failed} tone="critical" />
          </MetricRow>
        </Panel>
      )}

      {bulkMessage && (
        <Notice tone="positive" className="mb-4">
          {bulkMessage}
        </Notice>
      )}
      {bulkError && (
        <ErrorState title="Scoring" message={bulkError} className="mb-4" />
      )}

      {/* -------------------------------------------------------- toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2 border-y border-hairline py-2">
        <label className="flex items-center gap-2 text-micro font-medium uppercase tracking-[0.075em] text-tertiary">
          Sort
          <Select
            value={sort}
            onChange={(e) => setSort(parseJobSort(e.target.value))}
            data-testid="jobs-sort"
            className="w-auto"
          >
            {JOB_SORT_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {JOB_SORT_LABELS[option]}
              </option>
            ))}
          </Select>
        </label>

        {sort !== DEFAULT_JOB_SORT && (
          <Button size="sm" variant="ghost" onClick={() => setSort(DEFAULT_JOB_SORT)}>
            <RotateCcw className="size-3" aria-hidden />
            Newest
          </Button>
        )}

        {filters !== EMPTY_FILTERS && (
          <Button size="sm" variant="ghost" onClick={() => setFilters(EMPTY_FILTERS)}>
            <X className="size-3" aria-hidden />
            Clear filters
          </Button>
        )}

        <p className="ml-auto font-mono text-micro text-tertiary tabular" data-testid="results-count">
          {jobs.length.toLocaleString()} / {total.toLocaleString()}
        </p>
      </div>

      {showFilters && (
        <div className="mb-4">
          <JobFilters filters={filters} onChange={setFilters} />
        </div>
      )}

      {showForm && (
        <Panel className="mb-4">
          <form onSubmit={handleSubmit} className="space-y-3">
            <p className="text-small font-medium text-primary">
              Add a job manually
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Job title *">
                <Input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </Field>
              <Field label="Company *">
                <Input required value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
              </Field>
              <Field label="Location">
                <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Remote, New York NY" />
              </Field>
              <Field label="Posting date">
                <Input type="date" value={form.postingDate} onChange={(e) => setForm({ ...form, postingDate: e.target.value })} />
              </Field>
              <Field label="Internship term">
                <Input value={form.internshipTerm} onChange={(e) => setForm({ ...form, internshipTerm: e.target.value })} placeholder="Summer 2027" />
              </Field>
              <Field label="Duration">
                <Input value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} placeholder="10 weeks" />
              </Field>
              <Field label="Official URL" className="sm:col-span-2">
                <Input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…" />
              </Field>
              <Field label="Full job description *" className="sm:col-span-2">
                <Textarea required rows={7} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Paste the complete job description…" />
              </Field>
            </div>
            {formError && <ErrorState title="Could not save" message={formError} />}
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={submitting}>
                {submitting ? "Saving…" : "Save job"}
              </Button>
              <Button variant="ghost" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Panel>
      )}

      <div className="mb-4 space-y-3">
        <SyncStatusPanel onSynced={loadJobs} />
        <SchedulerHealthPanel />
      </div>

      {/* --------------------------------------------------------- results */}
      {fetchError && (
        <ErrorState
          title="Jobs unavailable"
          message={fetchError}
          onRetry={() => void loadJobs()}
          className="mb-4"
        />
      )}

      {viewState === "loading" ? (
        <SkeletonRows rows={6} />
      ) : viewState === "error" ? null : viewState === "empty" ? (
        <EmptyState
          title="No jobs match these filters"
          description="Jobs loaded successfully, but nothing matched. Try Sync Now, or loosen the filters."
          action={
            <Button variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {jobs.map((job) => (
              <JobCard key={job.id} job={job} />
            ))}
          </div>
          {jobs.length < total && (
            <div className="mt-5 flex justify-center">
              <Button size="lg" onClick={loadMore} disabled={loadingMore}>
                {loadingMore
                  ? "Loading…"
                  : `Load more · ${(total - jobs.length).toLocaleString()} remaining`}
              </Button>
            </div>
          )}
        </>
      )}
    </PageBody>
  );
}
