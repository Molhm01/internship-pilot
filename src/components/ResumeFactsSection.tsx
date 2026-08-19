"use client";

import { useEffect, useState, useCallback } from "react";
import ResumeUploader from "@/components/ResumeUploader";
import { FACT_TYPE_LABELS, FactType } from "@/lib/statuses";

type ApprovedFact = {
  id: string;
  type: FactType;
  content: string;
  detail: string | null;
  status: string;
  source: string;
};

export default function ResumeFactsSection() {
  const [approved, setApproved] = useState<ApprovedFact[]>([]);
  const [loadingApproved, setLoadingApproved] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadApproved = useCallback(async () => {
    setLoadingApproved(true);
    setError(null);
    try {
      const res = await fetch("/api/resume/facts", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load resume evidence.");
      setApproved(
        (data.facts ?? []).filter((fact: ApprovedFact) =>
          fact.status === "approved" || fact.status === "edited",
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load resume evidence.");
    } finally {
      setLoadingApproved(false);
    }
  }, []);

  useEffect(() => {
    void loadApproved();
  }, [loadApproved]);

  async function updateApproved(id: string, patch: Partial<ApprovedFact>) {
    const res = await fetch(`/api/resume/facts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const data = await res.json();
      setApproved((prev) => prev.map((f) => (f.id === id ? data.fact : f)));
    }
  }

  async function deleteApproved(id: string) {
    const res = await fetch(`/api/resume/facts/${id}`, { method: "DELETE" });
    if (res.ok) {
      setApproved((prev) => prev.filter((f) => f.id !== id));
    }
  }

  const approvedByType = groupByType(approved);

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Resume & ATS scoring</h1>
        <p className="text-secondary text-sm max-w-3xl">
          Upload one resume. Internship Pilot automatically extracts only evidence written in the PDF, scores it against every active internship, and scores new jobs as they arrive. Uploading a replacement resume automatically refreshes the scores.
        </p>
      </header>

      <ResumeUploader onProcessed={loadApproved} />

      {error && (
        <div className="rounded-lg bg-critical-quiet border border-critical-line text-critical text-sm px-4 py-3">
          {error}
        </div>
      )}

      <section className="space-y-4">
        <div>
          <h2 className="font-medium text-primary">Resume evidence</h2>
          <p className="mt-1 text-xs text-tertiary">
            Optional review. Scoring starts automatically; you do not need to approve these first. Edit or remove anything that is not represented correctly and affected jobs will be re-scored automatically.
          </p>
        </div>

        {loadingApproved ? (
          <p className="text-sm text-tertiary">Loading…</p>
        ) : approved.length === 0 ? (
          <p className="text-sm text-tertiary">
            Upload a text-based resume PDF above to create the scoring evidence automatically.
          </p>
        ) : (
          <div className="space-y-6">
            {Object.entries(approvedByType).map(([type, facts]) => (
              <div key={type}>
                <h3 className="text-xs uppercase tracking-wide font-semibold text-tertiary mb-2">
                  {FACT_TYPE_LABELS[type as FactType] ?? type} ({facts.length})
                </h3>
                <div className="space-y-2">
                  {facts.map((fact) => (
                    <ApprovedFactRow
                      key={fact.id}
                      fact={fact}
                      onSave={(patch) => updateApproved(fact.id, patch)}
                      onDelete={() => deleteApproved(fact.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ApprovedFactRow({
  fact,
  onSave,
  onDelete,
}: {
  fact: ApprovedFact;
  onSave: (patch: Partial<ApprovedFact>) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(fact.content);
  const [detail, setDetail] = useState(fact.detail ?? "");

  function save() {
    onSave({ content, detail });
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-accent-line/40 bg-accent/5 p-3">
        <div className="flex-1 space-y-1.5">
          <input
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full text-sm font-medium bg-surface border border-line rounded px-2 py-1 focus:outline-none focus:border-accent-line"
          />
          <input
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="Optional supporting detail"
            className="w-full text-xs bg-surface border border-line rounded px-2 py-1 focus:outline-none focus:border-accent-line"
          />
        </div>
        <div className="flex flex-col gap-1">
          <button onClick={save} className="text-xs font-medium text-accent-text hover:underline">
            Save
          </button>
          <button onClick={() => setEditing(false)} className="text-xs text-faint hover:text-secondary">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-lg border border-hairline p-3 group">
      <div className="flex-1">
        <p className="text-sm font-medium text-primary">{fact.content}</p>
        {fact.detail && <p className="text-xs text-tertiary">{fact.detail}</p>}
      </div>
      <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={() => setEditing(true)} className="text-xs text-faint hover:text-accent-text">
          Edit
        </button>
        <button onClick={onDelete} className="text-xs text-faint hover:text-rose-600">
          Delete
        </button>
      </div>
    </div>
  );
}

function groupByType(facts: ApprovedFact[]): Record<string, ApprovedFact[]> {
  const groups: Record<string, ApprovedFact[]> = {};
  for (const fact of facts) {
    if (!groups[fact.type]) groups[fact.type] = [];
    groups[fact.type].push(fact);
  }
  return groups;
}
