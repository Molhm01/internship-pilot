"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Compass, FileText, RefreshCw, UserRound } from "lucide-react";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { Metric, MetricRow } from "@/components/ui/Metric";
import { Section, Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/State";
import { Badge } from "@/components/ui/Badge";
import { fetchJobCounts, fetchJobsPage } from "@/lib/jobs/jobsApi";
import { postedLabel } from "@/lib/jobs/postedAge";
import { MatchScore } from "@/components/product/MatchScore";
import { AvailabilityBadge } from "@/components/product/AvailabilityBadge";
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

/**
 * Dashboard.
 *
 * Every number here is read from the same APIs the rest of the app uses — there
 * are no illustrative figures. When a value is unavailable the tile says so
 * rather than showing a zero, because a fabricated zero is worse than a gap.
 */
export function DashboardClient() {
  const [counts, setCounts] = useState<JobCounts | null>(null);
  const [recent, setRecent] = useState<JobCardData[]>([]);
  const [strong, setStrong] = useState<JobCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const newestQuery = new URLSearchParams({ limit: "5", offset: "0", sort: "newest" });
      const matchQuery = new URLSearchParams({ limit: "5", offset: "0", sort: "match" });
      const [countsResult, newest, byMatch] = await Promise.all([
        fetchJobCounts<JobCounts>(),
        fetchJobsPage<JobCardData>(newestQuery),
        fetchJobsPage<JobCardData>(matchQuery),
      ]);
      setCounts(countsResult);
      setRecent(newest.jobs);
      setStrong(byMatch.jobs.filter((job) => (job.matchResults?.[0]?.score ?? 0) >= 75));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load your workspace.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <PageBody>
      <PageHeader
        title={`${greeting()}.`}
        description={
          counts
            ? `${counts.active.toLocaleString()} active internships tracked. ${counts.unscored.toLocaleString()} still unscored.`
            : "Loading your workspace…"
        }
        actions={
          <>
            <Button size="md" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
              Refresh
            </Button>
            <Link
              href="/jobs"
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 text-small font-medium text-inverse transition-colors duration-[120ms] ease-standard hover:bg-accent-hover"
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
            <Metric label="Active" value={counts.active.toLocaleString()} tone="accent" />
            <Metric label="Verified" value={counts.officiallyVerified.toLocaleString()} tone="positive" />
            <Metric label="Source listed" value={counts.sourceListed.toLocaleString()} tone="info" />
            <Metric label="Pending" value={counts.verificationPending.toLocaleString()} tone="caution" />
            <Metric label="Scored" value={counts.scored.toLocaleString()} />
            <Metric label="Unscored" value={counts.unscored.toLocaleString()} tone="caution" />
            <Metric label="Eligible" value={counts.eligibilityPass.toLocaleString()} tone="positive" />
          </MetricRow>
        </Panel>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-8">
          <Section
            title="Strong matches"
            description="Scored 75 or above by the local model."
            actions={
              <Link
                href="/jobs?sort=match"
                className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-micro text-tertiary transition-colors hover:text-primary"
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
                description="Run AI Match on your discovered internships to see which ones fit your profile."
                action={
                  <Link
                    href="/jobs"
                    className="inline-flex h-7 items-center rounded-md border border-line bg-surface px-2.5 text-small text-primary hover:bg-n-150"
                  >
                    Go to Discover
                  </Link>
                }
              />
            ) : (
              <ul className="divide-y divide-hairline border-y border-hairline">
                {strong.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="Recently discovered"
            description="Newest by the date the source published, not when it was ingested."
          >
            {loading ? (
              <SkeletonRows rows={3} />
            ) : recent.length === 0 ? (
              <EmptyState
                title="Nothing discovered yet"
                description="Run a sync to pull internships from your approved sources."
              />
            ) : (
              <ul className="divide-y divide-hairline border-y border-hairline">
                {recent.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </ul>
            )}
          </Section>
        </div>

        <div className="space-y-8">
          <Section title="Next actions">
            <div className="space-y-px overflow-hidden rounded-lg border border-hairline">
              <ActionRow
                href="/profile"
                icon={UserRound}
                title="Complete your profile"
                body="The Agent can only answer from facts stored here."
              />
              <ActionRow
                href="/documents"
                icon={FileText}
                title="Review documents"
                body="Master résumé and reusable bullet library."
              />
              <ActionRow
                href="/agent"
                icon={Compass}
                title="Open the Agent"
                body="Review runs and answer pending questions."
              />
            </div>
          </Section>

          {counts && counts.unscored > 0 && (
            <Panel tone="caution">
              <p className="text-small font-medium text-primary">
                {counts.unscored.toLocaleString()} internships are unscored
              </p>
              <p className="mt-1 text-small text-secondary">
                AI Match has not run on these yet, so their fit is unknown.
              </p>
              <Link
                href="/jobs"
                className="mt-3 inline-flex h-7 items-center rounded-md border border-line bg-surface px-2.5 text-small text-primary transition-colors hover:bg-n-150"
              >
                Score them
              </Link>
            </Panel>
          )}
        </div>
      </div>
    </PageBody>
  );
}

function JobRow({ job }: { job: JobCardData }) {
  const posted = postedLabel(job);
  const match = job.matchResults?.[0];
  return (
    <li>
      <Link
        href={`/jobs/${job.id}`}
        className="flex items-center gap-3 px-1 py-2.5 transition-colors duration-[120ms] ease-standard hover:bg-n-100"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-small font-medium text-primary">{job.title}</p>
          <p className="truncate text-micro text-tertiary">
            {job.company}
            {job.location ? ` · ${job.location}` : ""}
          </p>
        </div>
        {job.verificationStatus && (
          <AvailabilityBadge status={job.verificationStatus} className="hidden sm:inline-flex" />
        )}
        <span className="shrink-0 font-mono text-micro text-faint tabular">{posted.text}</span>
        {match ? (
          <MatchScore score={match.score} size="sm" />
        ) : (
          <Badge tone="neutral">Unscored</Badge>
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
      className="flex items-start gap-3 bg-surface px-3 py-3 transition-colors duration-[120ms] ease-standard hover:bg-n-100"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-tertiary" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-small text-primary">{title}</span>
        <span className="block text-micro text-tertiary">{body}</span>
      </span>
      <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
    </Link>
  );
}
