"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CheckCircle2, Clock, Loader2, MapPin, Play } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { toast } from "@/components/ui/Toast";
import { MatchScore } from "./MatchScore";
import { postedLabel } from "@/lib/jobs/postedAge";
import { selectStoredApplicationLinks } from "@/lib/jobs/applicationUrl";
import { STATUS_LABELS, type TrackerStatus } from "@/lib/statuses";
import { getGmailAccessToken } from "@/lib/gmail/clientAuth";

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
  matchResults?: { score: number; eligibility: string }[];
};

export function JobCard({ job, className }: { job: JobCardData; className?: string }) {
  const [applying, setApplying] = useState(false);
  const [applyOutcome, setApplyOutcome] = useState<{
    status: string;
    label: string;
    detail?: string;
  } | null>(null);

  const hasCurrentScore = Number.isInteger(job.matchScore)
    && job.matchScore! >= 0
    && job.matchScore! <= 100;
  const latestMatch = hasCurrentScore
    ? { score: job.matchScore!, eligibility: job.eligibilityStatus ?? "Unknown" }
    : undefined;
  const posted = postedLabel(job);
  const { applicationUrl, sourceListingUrl } = selectStoredApplicationLinks(job);
  const externalUrl = applicationUrl ?? sourceListingUrl;
  const statusLabel = applyOutcome?.label ?? (STATUS_LABELS[job.status as TrackerStatus] ?? job.status);
  const alreadySubmitted = job.status === "SUBMITTED" || applyOutcome?.status === "submitted";

  async function triggerAutoApply(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (applying) return;
    setApplying(true);
    const toastId = toast.loading(`Auto-applying to ${job.company}…`, {
      description: job.title,
    });
    try {
      const gmailToken = getGmailAccessToken();
      const res = await fetch(`/api/jobs/${job.id}/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(gmailToken ? { Authorization: `Bearer ${gmailToken}` } : {}),
        },
        body: JSON.stringify({ mode: "auto_submit" }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const st = String(data.status ?? "submitted");
        const detail = typeof data.detail === "string" ? data.detail : undefined;
        const label =
          st === "submitted"
            ? data.confirmationNumber
              ? `Submitted · #${String(data.confirmationNumber)}`
              : "Submitted"
            : st === "filled"
              ? "Prepared — See Run"
              : st === "failed"
                ? "Paused — Needs Review"
                : st.replace(/_/g, " ");
        setApplyOutcome({ status: st, label, detail });

        if (st === "submitted") {
          toast.success(`Submitted to ${job.company}`, {
            id: toastId,
            description: detail ?? label,
          });
        } else if (st === "failed") {
          toast.error(`Auto-Apply paused on ${job.company}`, {
            id: toastId,
            description: detail ?? "Open job details to inspect the blocker.",
          });
        } else {
          toast.info(`Prepared packet for ${job.company}`, {
            id: toastId,
            description: detail ?? "Saved form answers & screenshot for review.",
          });
        }
      } else {
        const errMsg = typeof data.error === "string" ? data.error : "Auto-Apply could not complete.";
        setApplyOutcome({
          status: "error",
          label: errMsg.slice(0, 48),
          detail: errMsg,
        });
        toast.error(`Auto-Apply could not finish for ${job.company}`, {
          id: toastId,
          description: errMsg,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Network error during Auto-Apply.";
      setApplyOutcome({ status: "error", label: "Network error", detail: errMsg });
      toast.error(`Auto-Apply failed for ${job.company}`, {
        id: toastId,
        description: errMsg,
      });
    } finally {
      setApplying(false);
    }
  }

  return (
    <article
      className={cn(
        "group flex flex-col justify-between rounded-lg border border-hairline bg-surface shadow-raised",
        "transition-colors duration-[140ms] ease-standard hover:border-line-strong focus-within:border-accent-line",
        className,
      )}
    >
      <Link href={`/jobs/${job.id}`} className="block flex-1 rounded-t-lg p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-display truncate text-small font-semibold text-primary group-hover:text-accent-text">
              {job.title}
            </h3>
            <p className="mt-0.5 truncate text-small font-medium text-secondary">
              {job.company}
            </p>
          </div>
          <div className="flex shrink-0 items-center">
            {latestMatch ? (
              <div className="flex items-center gap-1.5" title="ATS resume-to-job match score">
                <MatchScore score={latestMatch.score} size="sm" />
              </div>
            ) : (
              <span className="font-mono text-micro text-tertiary">Scoring…</span>
            )}
          </div>
        </div>

        <dl className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-tertiary">
          {job.location && (
            <div className="flex min-w-0 items-center gap-1">
              <MapPin className="size-3 shrink-0 text-faint" aria-hidden />
              <dd className="truncate">{job.location}</dd>
            </div>
          )}
          {job.workplaceType && (
            <>
              <span aria-hidden className="text-faint">·</span>
              <dd>{job.workplaceType}</dd>
            </>
          )}
          {job.internshipTerm && (
            <>
              <span aria-hidden className="text-faint">·</span>
              <dd>{job.internshipTerm}</dd>
            </>
          )}
          <span aria-hidden className="text-faint">·</span>
          <div
            className={cn("flex items-center gap-1", posted.unknown && "italic text-faint")}
            title={posted.title}
            data-testid="job-posted-age"
          >
            <Clock className="size-3 shrink-0 text-faint" aria-hidden />
            <dd className="font-mono tabular">{posted.text}</dd>
          </div>
        </dl>

        <div className="mt-2.5 flex items-center justify-between gap-2 text-micro">
          <span
            className={cn(
              "truncate font-medium",
              alreadySubmitted ? "text-verified" : "text-tertiary",
            )}
          >
            {statusLabel}
          </span>
          {job.verificationStatus === "VERIFIED_OFFICIAL_AT_LAST_CHECK" && (
            <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-verified">
              <CheckCircle2 className="size-3" aria-hidden />
              Verified ATS
            </span>
          )}
        </div>
          {applyOutcome?.detail && (
            <p
              className={cn(
                "mt-2 line-clamp-2 text-[11px] leading-snug",
                applyOutcome.status === "submitted"
                  ? "text-verified"
                  : applyOutcome.status === "error" || applyOutcome.status === "failed"
                    ? "text-critical"
                    : "text-info",
              )}
              title={applyOutcome.detail}
            >
              {applyOutcome.detail}
            </p>
          )}
      </Link>

      <div className="flex items-center justify-between gap-2 border-t border-hairline bg-canvas/50 px-4 py-2.5 rounded-b-lg">
        <Link
          href={`/jobs/${job.id}`}
          className="text-micro font-medium text-secondary hover:text-primary whitespace-nowrap shrink-0"
        >
          View details
        </Link>

        <div className="flex shrink-0 items-center gap-1.5">
          {externalUrl && (
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={applicationUrl ? "Open official employer page" : "Open source listing"}
              aria-label="Open external application page"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-tertiary transition-colors hover:border-line-strong hover:text-primary"
            >
              <ArrowUpRight className="size-3.5" aria-hidden />
            </a>
          )}

          <button
            type="button"
            onClick={(e) => void triggerAutoApply(e)}
            disabled={applying || alreadySubmitted}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-micro font-medium transition-colors duration-[120ms] ease-standard disabled:opacity-55",
              alreadySubmitted
                ? "border border-verified-line bg-verified-quiet text-verified"
                : "border border-accent bg-accent text-inverse hover:bg-accent-hover",
            )}
          >
            {applying ? (
              <>
                <Loader2 className="size-3 animate-spin" aria-hidden />
                Applying…
              </>
            ) : alreadySubmitted ? (
              <>
                <CheckCircle2 className="size-3" aria-hidden />
                Applied
              </>
            ) : (
              <>
                <Play className="size-3" aria-hidden />
                Auto-Apply
              </>
            )}
          </button>
        </div>
      </div>
    </article>
  );
}

export default JobCard;
