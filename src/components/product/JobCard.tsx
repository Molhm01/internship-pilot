"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink, Sparkles, MapPin, CalendarDays, Clock } from "lucide-react";
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
import { hasUsableJobDescription, requestManualMatch } from "@/lib/matchWorkflow";
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
  matchResults?: { score: number; eligibility: string }[];
};

/**
 * Job card.
 *
 * All behaviour is carried over unchanged from the original component: the
 * posted label still comes from the SOURCE date only (never firstSeenAt), the
 * apply target still comes from selectStoredApplicationLinks, and manual match
 * still runs through requestManualMatch with its own local state.
 *
 * The redesign is structural — quick actions no longer sit inside the card's
 * <Link>, which previously meant every action had to call preventDefault and
 * stopPropagation to avoid navigating. The card body is the link; the action
 * row is its sibling.
 */
export function JobCard({ job, className }: { job: JobCardData; className?: string }) {
  const [latestMatch, setLatestMatch] = useState(job.matchResults?.[0]);
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);

  const posted = postedLabel(job);
  const { applicationUrl, sourceListingUrl } = selectStoredApplicationLinks(job);
  const canRunMatch = hasUsableJobDescription(job.description);
  const automaticMatchStatus = initialMatchUiStatus(job.scoringState, Boolean(latestMatch));

  async function handleRunMatch() {
    setMatchError(null);
    setMatching(true);
    try {
      const result = await requestManualMatch(job.id);
      setLatestMatch({ score: result.score, eligibility: result.eligibility });
    } catch (error) {
      setMatchError(error instanceof Error ? error.message : "Could not run AI Match.");
    } finally {
      setMatching(false);
    }
  }

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
              <MatchScore score={latestMatch.score} size="sm" />
            ) : automaticMatchStatus ? (
              <Badge
                tone={automaticMatchStatus === "Scoring delayed" ? "caution" : "info"}
                dot={automaticMatchStatus === "Scoring"}
              >
                {automaticMatchStatus}
              </Badge>
            ) : null}
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
          <TrackerStatusBadge status={job.status} />
          {job.verificationStatus && <AvailabilityBadge status={job.verificationStatus} />}
        </div>
      </Link>

      <div className="flex items-center gap-1.5 border-t border-hairline px-3.5 py-2">
        <button
          type="button"
          onClick={() => void handleRunMatch()}
          disabled={matching || !canRunMatch}
          title={canRunMatch ? undefined : "A usable job description is required"}
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-md border border-line bg-surface px-2",
            "text-micro font-medium text-secondary transition-colors duration-[120ms] ease-standard",
            "hover:border-line-strong hover:text-primary",
            "disabled:cursor-not-allowed disabled:opacity-45",
          )}
        >
          <Sparkles className={cn("size-3", matching && "animate-agent-pulse")} aria-hidden />
          {matching ? "Matching…" : latestMatch ? "Re-run match" : "Run AI Match"}
        </button>

        {applicationUrl ? (
          <button
            type="button"
            onClick={() => openStoredApplicationUrl(job)}
            className="ml-auto inline-flex h-6 items-center gap-1.5 rounded-md border border-accent bg-accent px-2 text-micro font-medium text-inverse transition-colors duration-[120ms] ease-standard hover:bg-accent-hover"
          >
            Apply
            <ExternalLink className="size-3" aria-hidden />
          </button>
        ) : sourceListingUrl ? (
          <button
            type="button"
            onClick={() =>
              window.open(sourceListingUrl, "_blank", "noopener,noreferrer")
            }
            title="The official employer application page has not been resolved yet."
            className="ml-auto inline-flex h-6 items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-micro font-medium text-secondary transition-colors duration-[120ms] ease-standard hover:border-line-strong hover:text-primary"
          >
            Source listing
            <ExternalLink className="size-3" aria-hidden />
          </button>
        ) : null}
      </div>

      {matchError && (
        <p className="border-t border-critical-line bg-critical-quiet px-3.5 py-1.5 text-micro text-critical" role="alert">
          {matchError}
        </p>
      )}
    </article>
  );
}

export default JobCard;
