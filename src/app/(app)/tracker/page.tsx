"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ExternalLink, FileText, Image as ImageIcon, RefreshCw } from "lucide-react";
import StatusSelector from "@/components/StatusSelector";
import { MatchScore } from "@/components/product/MatchScore";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { Panel, Section } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ArtifactPreviewModal } from "@/components/ui/ArtifactPreviewModal";
import { TRACKER_STATUSES, TrackerStatus } from "@/lib/statuses";

type TrackerJob = {
  id: string;
  title: string;
  company: string;
  status: string;
  atsType?: string | null;
  matchResults?: { score: number; eligibility: string }[];
};

type SubmittedRunRecord = {
  id: string;
  jobId: string;
  jobTitle: string;
  company: string;
  location: string | null;
  applyUrl: string | null;
  atsType: string;
  status: string;
  matchScoreAtRun: number | null;
  resumeDocumentId: string | null;
  coverLetterDocumentId: string | null;
  confirmationNumber: string | null;
  confirmationUrl: string | null;
  screenshotPath: string | null;
  answers: Record<string, string>;
  createdAt: string;
  finishedAt: string | null;
};

const COLUMN_ACCENT: Partial<Record<TrackerStatus, string>> = {
  DISCOVERED: "text-secondary",
  VERIFIED: "text-info",
  READY_TO_APPLY: "text-accent-text",
  SUBMITTED: "text-verified",
  ASSESSMENT_REQUIRED: "text-caution",
  INTERVIEW: "text-info",
  OFFER: "text-verified",
  REJECTED: "text-faint",
  FAILED: "text-critical",
};

export default function TrackerPage() {
  const [jobs, setJobs] = useState<TrackerJob[]>([]);
  const [runs, setRuns] = useState<SubmittedRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewArtifact, setPreviewArtifact] = useState<{
    open: boolean;
    url: string | null;
    title: string;
    filename?: string;
    kind?: "image" | "pdf";
  }>({ open: false, url: null, title: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [jobsRes, appsRes] = await Promise.all([
        fetch("/api/jobs"),
        fetch("/api/applications"),
      ]);
      const jobsData = await jobsRes.json().catch(() => ({}));
      const appsData = await appsRes.json().catch(() => ({}));
      setJobs(jobsData.jobs ?? []);
      setRuns(appsData.runs ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function moveJob(jobId: string, status: string) {
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, status } : j)));
    await fetch(`/api/jobs/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  }

  const submittedRuns = useMemo(
    () => runs.filter((r) => r.status === "submitted"),
    [runs],
  );

  const runByJobId = useMemo(() => {
    const map = new Map<string, SubmittedRunRecord>();
    for (const run of runs) {
      const existing = map.get(run.jobId);
      if (!existing || (existing.status !== "submitted" && run.status === "submitted")) {
        map.set(run.jobId, run);
      }
    }
    return map;
  }, [runs]);

  const PRIMARY_ORDER: TrackerStatus[] = [
    "SUBMITTED",
    "READY_TO_APPLY",
    "DISCOVERED",
    "ASSESSMENT_REQUIRED",
    "INTERVIEW",
    "OFFER",
    "REJECTED",
    "FAILED",
  ];
  const visibleStatuses = [
    ...PRIMARY_ORDER,
    ...TRACKER_STATUSES.filter(
      (s) => s !== "NEEDS_USER_ACTION" && !PRIMARY_ORDER.includes(s) && jobs.some((j) => j.status === s),
    ),
  ];
  const columns: Record<TrackerStatus, TrackerJob[]> = Object.fromEntries(
    TRACKER_STATUSES.map((s) => [s, jobs.filter((j) => j.status === s)]),
  ) as Record<TrackerStatus, TrackerJob[]>;

  return (
    <PageBody>
      <PageHeader
        title="Application Tracker"
        description="Documented submission ledger and full internship pipeline across every employer portal."
        actions={
          <Button size="md" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
            Refresh
          </Button>
        }
      />

      <Section
        title={`Submitted Applications Ledger (${submittedRuns.length})`}
        description="Every verified submission with confirmation number, submission timestamp, tailored PDFs, confirmation screenshot, and recorded form answers."
        className="mb-8"
      >
        {loading ? (
          <p className="text-small text-tertiary">Loading submission ledger…</p>
        ) : submittedRuns.length === 0 ? (
          <Panel className="text-small text-tertiary">
            No confirmed submissions recorded yet. Run the Autonomous Application Agent on{" "}
            <Link href="/agent" className="text-accent-text underline">
              /agent
            </Link>{" "}
            to submit applications and document them here automatically.
          </Panel>
        ) : (
          <div className="space-y-3">
            {submittedRuns.map((run) => {
              const answerEntries = Object.entries(run.answers ?? {});
              return (
                <Panel key={run.id} className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CheckCircle2 className="size-4 shrink-0 text-verified" aria-hidden />
                        <Link
                          href={`/jobs/${run.jobId}`}
                          className="font-display text-subhead font-medium text-primary hover:text-accent-text hover:underline"
                        >
                          {run.jobTitle}
                        </Link>
                        <Badge tone="positive">Submitted</Badge>
                        <Badge tone="neutral">{run.atsType.toUpperCase()}</Badge>
                        {run.matchScoreAtRun !== null && (
                          <Badge tone="neutral">{run.matchScoreAtRun}% Fit</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-small text-tertiary">
                        {run.company}
                        {run.location ? ` · ${run.location}` : ""} · Submitted{" "}
                        {new Date(run.finishedAt ?? run.createdAt).toLocaleString()}
                        {run.confirmationNumber ? ` · Confirmation #${run.confirmationNumber}` : ""}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {run.resumeDocumentId && (
                        <button
                          type="button"
                          onClick={() =>
                            setPreviewArtifact({
                              open: true,
                              url: `/api/documents/${run.resumeDocumentId}/download`,
                              title: `${run.company} · ${run.jobTitle} — Resume PDF`,
                              filename: `resume-${run.company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`,
                              kind: "pdf",
                            })
                          }
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2 text-micro font-medium text-secondary hover:bg-n-150"
                        >
                          <FileText className="size-3" aria-hidden />
                          Resume PDF
                        </button>
                      )}
                      {run.coverLetterDocumentId && (
                        <button
                          type="button"
                          onClick={() =>
                            setPreviewArtifact({
                              open: true,
                              url: `/api/documents/${run.coverLetterDocumentId}/download`,
                              title: `${run.company} · ${run.jobTitle} — Cover Letter PDF`,
                              filename: `cover-letter-${run.company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`,
                              kind: "pdf",
                            })
                          }
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2 text-micro font-medium text-secondary hover:bg-n-150"
                        >
                          <FileText className="size-3" aria-hidden />
                          Cover Letter PDF
                        </button>
                      )}
                      {run.screenshotPath && (
                        <button
                          type="button"
                          onClick={() =>
                            setPreviewArtifact({
                              open: true,
                              url: `/api/applications/${run.id}/screenshot`,
                              title: `${run.company} · ${run.jobTitle} — Confirmation Screenshot`,
                              filename: `confirmation-${run.id.slice(0, 8)}.png`,
                              kind: "image",
                            })
                          }
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2 text-micro font-medium text-secondary hover:bg-n-150"
                        >
                          <ImageIcon className="size-3" aria-hidden />
                          Confirmation Proof
                        </button>
                      )}
                      {(run.confirmationUrl || run.applyUrl) && (
                        <a
                          href={run.confirmationUrl || run.applyUrl || "#"}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2 text-micro font-medium text-accent-text hover:bg-n-150"
                        >
                          Portal Link
                          <ExternalLink className="size-3" aria-hidden />
                        </a>
                      )}
                    </div>
                  </div>

                  {answerEntries.length > 0 && (
                    <details className="rounded-md border border-hairline bg-sunken px-3 py-2 text-micro">
                      <summary className="cursor-pointer font-medium text-secondary">
                        View recorded submission answers ({answerEntries.length} fields documented)
                      </summary>
                      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2 text-secondary">
                        {answerEntries.map(([field, val]) => (
                          <li key={field} className="truncate">
                            <span className="font-medium text-primary">{field}:</span> {val}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </Panel>
              );
            })}
          </div>
        )}
      </Section>

      <Section
        title="Pipeline Board"
        description="Track active postings from discovery through submission, interviews, and offers."
      >
        {loading ? (
          <p className="text-small text-tertiary">Loading tracker…</p>
        ) : (
          <div className="flex gap-4 overflow-x-auto pb-4">
            {visibleStatuses.map((status) => (
              <div
                key={status}
                className="flex w-72 shrink-0 flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-raised"
              >
                <div className="flex items-center justify-between border-b border-hairline bg-raised px-3.5 py-2.5">
                  <span className={`font-mono text-micro font-semibold uppercase tracking-[0.06em] ${COLUMN_ACCENT[status] ?? "text-secondary"}`}>
                    {status.replace(/_/g, " ")}
                  </span>
                  <span className="font-mono text-micro text-faint tabular-nums">
                    {columns[status].length}
                  </span>
                </div>
                <div className="flex-1 space-y-2 bg-sunken/60 p-2.5 min-h-[140px]">
                  {columns[status].length === 0 ? (
                    <p className="py-6 text-center text-micro text-faint">No items</p>
                  ) : (
                    columns[status].map((job) => {
                      const run = runByJobId.get(job.id);
                      return (
                        <div
                          key={job.id}
                          className="space-y-2.5 rounded-md border border-hairline bg-surface p-3 shadow-raised transition-colors hover:border-line-strong"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <Link href={`/jobs/${job.id}`} className="min-w-0 flex-1">
                              <p className="truncate font-display text-small font-medium text-primary hover:text-accent-text">
                                {job.title}
                              </p>
                              <p className="truncate text-micro text-tertiary">{job.company}</p>
                            </Link>
                            {job.matchResults?.[0] && (
                              <MatchScore score={job.matchResults[0].score} size="sm" />
                            )}
                          </div>
                          {(run?.confirmationNumber || job.atsType) && (
                            <div className="flex flex-wrap items-center gap-1.5 text-micro">
                              {job.atsType && (
                                <span className="rounded bg-sunken px-1.5 py-0.5 font-mono uppercase text-tertiary">
                                  {job.atsType}
                                </span>
                              )}
                              {run?.confirmationNumber && (
                                <span className="rounded bg-verified-quiet px-1.5 py-0.5 font-mono text-verified">
                                  #{run.confirmationNumber}
                                </span>
                              )}
                            </div>
                          )}
                          <StatusSelector value={job.status} onChange={(s) => moveJob(job.id, s)} />
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <ArtifactPreviewModal
        open={previewArtifact.open}
        url={previewArtifact.url}
        title={previewArtifact.title}
        filename={previewArtifact.filename}
        kind={previewArtifact.kind}
        onClose={() => setPreviewArtifact({ open: false, url: null, title: "" })}
      />
    </PageBody>
  );
}
