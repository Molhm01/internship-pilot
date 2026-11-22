"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Bot, CheckCircle2, Compass, FileText, RefreshCw, UserRound } from "lucide-react";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { Metric, MetricRow } from "@/components/ui/Metric";
import { Section, Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/State";
import { fetchJobCounts, fetchJobsPage } from "@/lib/jobs/jobsApi";
import { postedLabel } from "@/lib/jobs/postedAge";
import { MatchScore } from "@/components/product/MatchScore";
import type { JobCardData } from "@/components/product/JobCard";

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

function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function currentScore(job: JobCardData): number | null {
  return Number.isInteger(job.matchScore) && job.matchScore! >= 0 && job.matchScore! <= 100
    ? job.matchScore!
    : null;
}

/** Dashboard values come from the same current per-user state as Discover. */
export function DashboardClient({ scoringConfigured = true }: { scoringConfigured?: boolean }) {
  const [counts, setCounts] = useState<JobCounts | null>(null);
  const [recent, setRecent] = useState<JobCardData[]>([]);
  const [strong, setStrong] = useState<JobCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [scoringNow, setScoringNow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const newestQuery = new URLSearchParams({ limit: "6", offset: "0", sort: "newest" });
      const matchQuery = new URLSearchParams({ limit: "6", offset: "0", sort: "match" });
      const [countsResult, newest, byMatch] = await Promise.all([
        fetchJobCounts<JobCounts>(),
        fetchJobsPage<JobCardData>(newestQuery),
        fetchJobsPage<JobCardData>(matchQuery),
      ]);
      setCounts(countsResult);
      setRecent(newest.jobs);
      setStrong(byMatch.jobs.filter((job) => (currentScore(job) ?? -1) >= 75));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load your workspace.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function scoreRemainingNow() {
    setScoringNow(true);
    try {
      await fetch("/api/jobs/score-unscored", { method: "POST" });
      await load();
    } finally {
      setScoringNow(false);
    }
  }

  const scoredPct = counts && counts.active > 0
    ? Math.round((counts.scored / counts.active) * 100)
    : 100;

  return (
    <PageBody>
      <PageHeader
        title={`${greeting()}.`}
        description={
          counts
            ? `${counts.active.toLocaleString()} fresh active internships (<=7d) · ${scoredPct}% ATS scored.`
            : "Loading your workspace…"
        }
        actions={
          <>
            <Button size="md" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
              Refresh
            </Button>
            <Link
              href="/agent"
              className="inline-flex h-7 shrink-0 whitespace-nowrap items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-small font-medium text-primary shadow-raised transition-colors duration-[120ms] ease-standard hover:bg-n-150"
            >
              <Bot className="size-3.5 text-accent" aria-hidden />
              Auto-Pilot
            </Link>
            <Link
              href="/jobs"
              className="inline-flex h-7 shrink-0 whitespace-nowrap items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 text-small font-medium text-inverse transition-colors duration-[120ms] ease-standard hover:bg-accent-hover"
            >
              <Compass className="size-3.5" aria-hidden />
              Discover
            </Link>
          </>
        }
      />

      {error && (
        <ErrorState
          title="Workspace unavailable"
          message={error}
          onRetry={() => void load()}
          className="mb-6"
        />
      )}

      {counts && (
        <Panel flush className="mb-8">
          <MetricRow className="px-4 py-1">
            <Metric label="Fresh Active (<=7d)" value={counts.active.toLocaleString()} tone="accent" />
            <Metric
              label={`Scored (${scoredPct}%)`}
              value={counts.scored.toLocaleString()}
              tone={counts.unscored === 0 ? "positive" : "caution"}
            />
            <Metric label="Strong Fit (>=75%)" value={counts.eligibilityPass.toLocaleString()} tone="positive" />
            <Metric label="Verified ATS" value={counts.officiallyVerified.toLocaleString()} tone="info" />
          </MetricRow>
        </Panel>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-8">
          <Section
            title="Strong matches"
            description="Top fresh internships scored 75 or above against your resume."
            actions={
              <Link
                href="/jobs?sort=match"
                className="inline-flex h-6 shrink-0 whitespace-nowrap items-center gap-1 rounded-md px-1.5 text-micro font-medium text-tertiary transition-colors hover:text-primary"
              >
                View all <ArrowRight className="size-3" aria-hidden />
              </Link>
            }
          >
            {loading ? (
              <SkeletonRows rows={3} />
            ) : strong.length === 0 ? (
              <EmptyState
                title="No strong matches yet"
                description={
                  scoringConfigured
                    ? "Upload your resume once. Internship Pilot scores every active internship immediately."
                    : "Upload your resume on the Resume page to score all active internships automatically."
                }
                action={
                  <Link
                    href="/profile"
                    className="inline-flex h-7 items-center rounded-md border border-line bg-surface px-2.5 text-small font-medium text-primary hover:bg-n-150"
                  >
                    Upload resume
                  </Link>
                }
              />
            ) : (
              <ul className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-surface shadow-raised">
                {strong.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="Newest fresh openings (<= 7d)"
            description="Ordered by the timestamp the employer or radar source published."
          >
            {loading ? (
              <SkeletonRows rows={3} />
            ) : recent.length === 0 ? (
              <EmptyState
                title="No fresh openings in cache"
                description="Run a live discovery sweep from Discover or Auto-Pilot to ingest fresh roles."
              />
            ) : (
              <ul className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-surface shadow-raised">
                {recent.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </ul>
            )}
          </Section>
        </div>

        <div className="space-y-6">
          <Section title="Workspace shortcuts">
            <div className="space-y-px overflow-hidden rounded-lg border border-hairline shadow-raised">
              <ActionRow
                href="/profile"
                icon={UserRound}
                title="Resume profile"
                body="Upload your PDF once — scores 100% of active internships immediately."
              />
              <ActionRow
                href="/agent"
                icon={Bot}
                title="Autonomous Auto-Pilot"
                body="Run hands-free applications, inspect live submissions, and track confirmations."
              />
              <ActionRow
                href="/documents"
                icon={FileText}
                title="Documents & candidate vault"
                body="Cover letters, reusable resume bullets, and application defaults."
              />
            </div>
          </Section>

          {counts && counts.unscored > 0 ? (
            <Panel tone="caution" className="space-y-3">
              <p className="text-small font-medium text-primary">
                {counts.unscored.toLocaleString()} new posting(s) queued for instant scoring
              </p>
              <p className="text-micro text-secondary">
                All active postings score automatically on upload or click below to score immediately.
              </p>
              <Button size="sm" variant="primary" onClick={() => void scoreRemainingNow()} disabled={scoringNow}>
                {scoringNow ? "Scoring…" : "Score all now"}
              </Button>
            </Panel>
          ) : counts && counts.active > 0 ? (
            <Panel tone="accent" className="flex items-start gap-2.5">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-verified" aria-hidden />
              <div>
                <p className="text-small font-medium text-primary">100% catalog scored</p>
                <p className="text-micro text-secondary">
                  All {counts.active.toLocaleString()} fresh internships have current ATS scores.
                </p>
              </div>
            </Panel>
          ) : null}
        </div>
      </div>
    </PageBody>
  );
}

function JobRow({ job }: { job: JobCardData }) {
  const posted = postedLabel(job);
  const score = currentScore(job);
  return (
    <li>
      <Link
        href={`/jobs/${job.id}`}
        className="flex items-center gap-3 px-4 py-3 transition-colors duration-[120ms] ease-standard hover:bg-n-100"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-small font-medium text-primary">{job.title}</p>
          <p className="truncate text-micro text-tertiary">
            {job.company}
            {job.location ? ` · ${job.location}` : ""}
            {job.verificationStatus === "OFFICIALLY_VERIFIED" ? " · Verified ATS" : ""}
          </p>
        </div>
        <span className="shrink-0 font-mono text-micro text-faint tabular-nums">{posted.text}</span>
        {score !== null ? (
          <MatchScore score={score} size="sm" />
        ) : (
          <span className="shrink-0 font-mono text-micro text-faint tabular-nums">—</span>
        )}
      </Link>
    </li>
  );
}

function ActionRow({
  href,
  icon: Icon,
  title,
  body,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-start gap-3 bg-surface px-4 py-3 transition-colors duration-[120ms] ease-standard hover:bg-n-100"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block font-display text-small font-medium text-primary">{title}</span>
        <span className="block text-micro text-tertiary">{body}</span>
      </span>
      <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
    </Link>
  );
}
