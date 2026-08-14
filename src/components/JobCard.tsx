"use client";

import { useState } from "react";
import Link from "next/link";
import StatusBadge from "@/components/StatusBadge";
import MatchScoreBadge from "@/components/MatchScoreBadge";
import VerificationBadge from "@/components/VerificationBadge";
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
  scoringState?: string | null;
  matchResults?: { score: number; eligibility: string }[];
};

export default function JobCard({ job }: { job: JobCardData }) {
  const [latestMatch, setLatestMatch] = useState(job.matchResults?.[0]);
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  // Age comes from the SOURCE posting date only. firstSeenAt is deliberately
  // not a fallback here: "when this app first saw it" is not "when it was
  // posted", and using it would relabel an old posting as brand new.
  const posted = postedLabel(job);
  const { applicationUrl, sourceListingUrl } = selectStoredApplicationLinks(job);
  const canRunMatch = hasUsableJobDescription(job.description);
  const automaticMatchStatus = initialMatchUiStatus(job.scoringState, Boolean(latestMatch));

  function handleApply(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    openStoredApplicationUrl(job);
  }

  function handleOpenSource(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (sourceListingUrl) {
      window.open(sourceListingUrl, "_blank", "noopener,noreferrer");
    }
  }

  async function handleRunMatch(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
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
    <Link
      href={`/jobs/${job.id}`}
      className="block bg-surface rounded-lg border border-hairline p-4 hover:border-accent-line/50 hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-primary truncate">{job.title}</p>
          <p className="text-sm text-secondary truncate">{job.company}</p>
        </div>
        {latestMatch && (
          <MatchScoreBadge score={latestMatch.score} eligibility={latestMatch.eligibility} />
        )}
        {automaticMatchStatus && (
          <span className={`rounded-full border px-2 py-1 text-xs font-medium ${
            automaticMatchStatus === "Scoring"
              ? "border-info-line bg-info-quiet text-info"
              : automaticMatchStatus === "Scoring delayed"
                ? "border-caution-line bg-caution-quiet text-caution"
                : "border-hairline bg-sunken text-secondary"
          }`}>
            {automaticMatchStatus}
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-tertiary">
        {job.location && <span>📍 {job.location}</span>}
        {job.workplaceType && <span>{job.workplaceType}</span>}
        {job.internshipTerm && <span>🗓 {job.internshipTerm}</span>}
        {job.duration && <span>⏱ {job.duration}</span>}
        <span
          title={posted.title}
          className={posted.unknown ? "text-faint italic" : undefined}
          data-testid="job-posted-age"
        >
          {posted.text}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex flex-wrap gap-2">
          <StatusBadge status={job.status} />
          {job.verificationStatus && <VerificationBadge status={job.verificationStatus} />}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleRunMatch}
            disabled={matching || !canRunMatch}
            title={canRunMatch ? undefined : "A usable job description is required"}
            className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-n-150 text-secondary hover:bg-n-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {matching ? "Matching…" : "★ Run AI Match Now"}
          </button>
          {applicationUrl && (
            <button
              type="button"
              onClick={handleApply}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
            >
              Apply ↗
            </button>
          )}
          {!applicationUrl && sourceListingUrl && (
            <button
              type="button"
              onClick={handleOpenSource}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-line text-secondary hover:bg-sunken"
            >
              Open source listing ↗
            </button>
          )}
        </div>
        {!applicationUrl && sourceListingUrl && (
          <p className="mt-2 text-xs text-caution">
            The official employer application page has not been resolved yet.
          </p>
        )}
        {matchError && (
          <p className="mt-2 text-xs text-critical" role="alert">
            {matchError}
          </p>
        )}
      </div>
    </Link>
  );
}
