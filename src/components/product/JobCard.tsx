"use client";

import Link from "next/link";
import { ExternalLink, MapPin, CalendarDays, Clock } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { TrackerStatusBadge } from "./TrackerStatusBadge";
import { AvailabilityBadge } from "./AvailabilityBadge";
import { MatchScore } from "./MatchScore";
import { Badge } from "@/components/ui/Badge";
import { postedLabel } from "@/lib/jobs/postedAge";
import {
  openStoredApplicationUrl,
  selectStoredApplicationLinks,
} from "@/lib/jobs/applicationUrl";
import { initialMatchUiStatus } from "@/lib/matching/initialMatchStatus";

export type JobCardData = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  postingDate: string | null;
  sourcePostedAt?: string | null;
  sourcePostedText?: string | null;
  sourceDateConfidence?: string | null;
  firstSeenAt?: string | null;
  internshipTerm: string | null;
  duration: string | null;
  description?: string | null;
  url?: string | null;
  sourceListingUrl?: string | null;
  officialApplicationUrl?: string | null;
  originalJobPostUrl?: string | null;
  resolutionStatus?: string | null;
  officialApplyUrl?: string | null;
  officialJobUrl?: string | null;
  jobDescriptionSourceUrl?: string | null;
  redirectChain?: string | null;
  sourceUrl?: string | null;
  status: string;
  verificationStatus?: string;
  workplaceType?: string | null;
  compensation?: string | null;
  scoringState?: string | null;
  matchScore?: number | null;
  eligibilityStatus?: string | null;
  scoreSource?: "BASELINE" | "AI_REFINED" | string | null;
  freshnessLabel?: "NEW" | "RECENT" | null;
  // Historical MatchResults may still be present in the API payload for audit
  // and job-detail use. The card deliberately ignores them: current display
  // state lives in UserJobState and is atomically replaced by a current-input
  // baseline as soon as a profile or JD revision changes.
  matchResults?: { score: number; eligibility: string }[];
};

/**
 * Job card. ATS scoring is automatic once a resume is uploaded; there is no
 * per-card run button in the normal workflow anymore.
 */
export function JobCard({ job, className }: { job: JobCardData; className?: string }) {
  const hasCurrentScore = Number.isInteger(job.matchScore)
    && job.matchScore! >= 0
    && job.matchScore! <= 100;
  const latestMatch = hasCurrentScore
    ? { score: job.matchScore!, eligibility: job.eligibilityStatus ?? "Unknown" }
    : undefined;
  const posted = postedLabel(job);
  const { applicationUrl, sourceListingUrl } = selectStoredApplicationLinks(job);
  const automaticMatchStatus = initialMatchUiStatus(job.scoringState, Boolean(latestMatch));
  const automaticWorkActive = automaticMatchStatus === "Scoring"
    || automaticMatchStatus === "Preparing job details";
  const freshnessBadge = job.freshnessLabel ?? null;

  return (
    <article
      className={cn(
        "group flex flex-col rounded-lg border border-hairline bg-surface",
        "transition-colors duration-[140ms] ease-standard hover:border-line focus-within:border-line",
        className,
      )}
    >
      <Link href={`/jobs/${job.id}`} className="flex-1 rounded-t-lg p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-small font-medium text-primary group-hover:text-accent-text">
              {job.title}
            </h3>
            <p className="mt-0.5 truncate text-small text-tertiary">{job.company}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {latestMatch ? (
              <div className="flex items-center gap-1.5" title="Candidate-to-job match">
                <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-tertiary">
                  {job.scoreSource === "AI_REFINED" ? "AI Match" : "Baseline"}
                </span>
                <MatchScore
                  score={latestMatch.score}
                  size="sm"
                  label={job.scoreSource === "AI_REFINED" ? "AI Match" : "Baseline match"}
                />
              </div>
            ) : automaticMatchStatus ? (
              <Badge
                tone={automaticMatchStatus === "Scoring delayed" ? "caution" : "info"}
                dot={automaticWorkActive}
              >
                {automaticMatchStatus}
              </Badge>
            ) : (
              <Badge tone="neutral">Upload resume to score</Badge>
            )}
          </div>
        </div>

        <dl className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-tertiary">
          {job.location && (
            <div className="flex min-w-0 items-center gap-1">
              <MapPin className="size-3 shrink-0 text-faint" aria-hidden />
              <dd className="truncate">{job.location}</dd>
            </div>
          )}
          {job.workplaceType && (
            <div className="flex items-center gap-1">
              <dd>{job.workplaceType}</dd>
            </div>
          )}
          {job.internshipTerm && (
            <div className="flex items-center gap-1">
              <CalendarDays className="size-3 shrink-0 text-faint" aria-hidden />
              <dd>{job.internshipTerm}</dd>
            </div>
          )}
          <div
            className={cn("flex items-center gap-1", posted.unknown && "italic text-faint")}
            title={posted.title}
            data-testid="job-posted-age"
          >
            <Clock className="size-3 shrink-0 text-faint" aria-hidden />
            <dd className="font-mono tabular">{posted.text}</dd>
          </div>
        </dl>

        <div className="mt-2.5 flex flex-wrap items-center gap-1">
          {freshnessBadge && <Badge tone={freshnessBadge === "NEW" ? "accent" : "info"}>{freshnessBadge}</Badge>}
          <TrackerStatusBadge status={job.status} />
          {job.verificationStatus && <AvailabilityBadge status={job.verificationStatus} />}
        </div>
      </Link>

      <div className="flex items-center justify-end gap-1.5 border-t border-hairline px-3.5 py-2">
        {applicationUrl ? (
          <button
            type="button"
            onClick={() => openStoredApplicationUrl(job)}
            className="inline-flex h-6 items-center gap-1.5 rounded-md border border-accent bg-accent px-2 text-micro font-medium text-inverse transition-colors duration-[120ms] ease-standard hover:bg-accent-hover"
          >
            Apply
            <ExternalLink className="size-3" aria-hidden />
          </button>
        ) : sourceListingUrl ? (
          <button
            type="button"
            onClick={() => window.open(sourceListingUrl, "_blank", "noopener,noreferrer")}
            title="The official employer application page has not been resolved yet."
            className="inline-flex h-6 items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-micro font-medium text-secondary transition-colors duration-[120ms] ease-standard hover:border-line-strong hover:text-primary"
          >
            Source listing
            <ExternalLink className="size-3" aria-hidden />
          </button>
        ) : null}
      </div>
    </article>
  );
}

export default JobCard;
