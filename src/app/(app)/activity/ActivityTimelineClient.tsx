"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { Panel, Section } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/State";

interface AuditEntryItem {
  id: string;
  jobId: string | null;
  jobTitle: string | null;
  company: string | null;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
}

interface SyncRunItem {
  id: string;
  source: string;
  status: string;
  newJobsCount: number;
  updatedJobsCount: number;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const ACTOR_FILTERS = [
  { id: "all", label: "All Events" },
  { id: "application-agent", label: "Application Agent" },
  { id: "ai-match", label: "AI Match" },
  { id: "document-generation", label: "Documents" },
  { id: "verification", label: "Verification" },
  { id: "user", label: "Workspace" },
] as const;

function actorTone(actor: string): "accent" | "positive" | "info" | "caution" | "neutral" {
  switch (actor) {
    case "application-agent":
      return "accent";
    case "ai-match":
      return "info";
    case "document-generation":
      return "positive";
    case "verification":
      return "caution";
    default:
      return "neutral";
  }
}

export function ActivityTimelineClient() {
  const [actor, setActor] = useState<string>("all");
  const [entries, setEntries] = useState<AuditEntryItem[]>([]);
  const [syncRuns, setSyncRuns] = useState<SyncRunItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/activity?actor=${encodeURIComponent(actor)}`);
      if (!res.ok) throw new Error("Failed to load activity log.");
      const json = (await res.json()) as {
        entries: AuditEntryItem[];
        syncRuns: SyncRunItem[];
      };
      setEntries(json.entries ?? []);
      setSyncRuns(json.syncRuns ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load activity timeline.");
    } finally {
      setLoading(false);
    }
  }, [actor]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <PageBody>
      <PageHeader
        title="Activity & Audit Timeline"
        description="Append-only operational ledger recording every AI score, tailored PDF compilation, ATS inspection, and submission action."
        actions={
          <Button size="md" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
            Refresh
          </Button>
        }
      />

      {error && (
        <ErrorState
          title="Could not load activity"
          message={error}
          onRetry={() => void load()}
          className="mb-6"
        />
      )}

      <div className="mb-6 flex flex-wrap gap-1.5">
        {ACTOR_FILTERS.map((f) => (
          <Button
            key={f.id}
            size="sm"
            variant={actor === f.id ? "primary" : "secondary"}
            onClick={() => setActor(f.id)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <Section title="Audit Events">
          {loading ? (
            <SkeletonRows rows={5} />
          ) : entries.length === 0 ? (
            <EmptyState
              title="No matching activity recorded yet"
              description="Actions taken by the Autonomous Agent, AI Match engine, and PDF generator appear here."
            />
          ) : (
            <ol className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
              {entries.map((entry) => (
                <li key={entry.id} className="space-y-1 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={actorTone(entry.actor)}>{entry.actor}</Badge>
                      <span className="font-mono text-micro text-tertiary">{entry.action}</span>
                    </div>
                    <span className="font-mono text-micro text-faint">
                      {new Date(entry.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-small text-primary">{entry.detail}</p>
                  {entry.jobId && (
                    <p className="text-micro text-tertiary">
                      Role:{" "}
                      <Link
                        href={`/jobs/${entry.jobId}`}
                        className="text-accent-text hover:underline"
                      >
                        {entry.jobTitle ?? entry.jobId}
                        {entry.company ? ` — ${entry.company}` : ""}
                      </Link>
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Section>

        <Section title="Discovery Sync Runs" description="Recent live ATS and feed ingestion checks.">
          {loading ? (
            <SkeletonRows rows={3} />
          ) : syncRuns.length === 0 ? (
            <Panel>
              <p className="text-small text-tertiary">
                No standalone sync batches recorded yet — discovery runs automatically on first load or via Auto-Pilot.
              </p>
            </Panel>
          ) : (
            <ul className="divide-y divide-hairline rounded-lg border border-hairline bg-surface">
              {syncRuns.map((run) => (
                <li key={run.id} className="space-y-1 px-4 py-3 text-small">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-primary">{run.source}</span>
                    <Badge tone={run.status === "success" ? "positive" : run.status === "error" ? "critical" : "info"}>
                      {run.status}
                    </Badge>
                  </div>
                  <p className="text-micro text-secondary">
                    +{run.newJobsCount} new · {run.updatedJobsCount} updated
                  </p>
                  {run.errorMessage && (
                    <p className="text-micro text-critical">{run.errorMessage}</p>
                  )}
                  <p className="font-mono text-micro text-faint">
                    {new Date(run.startedAt).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </PageBody>
  );
}
