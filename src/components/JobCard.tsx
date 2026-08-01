"use client";

import { useState } from "react";
import Link from "next/link";
import StatusBadge from "@/components/StatusBadge";
import MatchScoreBadge from "@/components/MatchScoreBadge";
import VerificationBadge, { postingAge } from "@/components/VerificationBadge";
import {
  openStoredApplicationUrl,
  selectStoredApplicationLinks,
} from "@/lib/jobs/applicationUrl";
import { hasUsableJobDescription, requestManualMatch } from "@/lib/matchWorkflow";

export type JobCardData = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  postingDate: string | null;
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
  matchResults?: { score: number; eligibility: string }[];
};

export default function JobCard({ job }: { job: JobCardData }) {
  const [latestMatch, setLatestMatch] = useState(job.matchResults?.[0]);
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const age = postingAge(job.postingDate ?? job.firstSeenAt ?? null);
  const { applicationUrl, sourceListingUrl } = selectStoredApplicationLinks(job);
  const canRunMatch = hasUsableJobDescription(job.description);

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
      className="block bg-white rounded-xl border border-slate-200 p-4 hover:border-brand/50 hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-slate-900 truncate">{job.title}</p>
          <p className="text-sm text-slate-600 truncate">{job.company}</p>
        </div>
        {latestMatch && (
          <MatchScoreBadge score={latestMatch.score} eligibility={latestMatch.eligibility} />
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        {job.location && <span>📍 {job.location}</span>}
        {job.workplaceType && <span>{job.workplaceType}</span>}
        {job.internshipTerm && <span>🗓 {job.internshipTerm}</span>}
        {job.duration && <span>⏱ {job.duration}</span>}
        {age && <span>Posted {age}</span>}
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
            className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {matching ? "Matching…" : "★ Run AI Match Now"}
          </button>
          {applicationUrl && (
            <button
              type="button"
              onClick={handleApply}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
            >
              Apply ↗
            </button>
          )}
          {!applicationUrl && sourceListingUrl && (
            <button
              type="button"
              onClick={handleOpenSource}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
            >
              Open source listing ↗
            </button>
          )}
        </div>
        {!applicationUrl && sourceListingUrl && (
          <p className="mt-2 text-xs text-amber-700">
            The official employer application page has not been resolved yet.
          </p>
        )}
        {matchError && (
          <p className="mt-2 text-xs text-rose-700" role="alert">
            {matchError}
          </p>
        )}
      </div>
    </Link>
  );
}
