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
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [approved, setApproved] = useState<ApprovedFact[]>([]);
  const [loadingApproved, setLoadingApproved] = useState(true);

  const loadApproved = useCallback(async () => {
    setLoadingApproved(true);
    try {
      const res = await fetch("/api/resume/facts?status=approved", { cache: "no-store" });
      const data = await res.json();
      setApproved(data.facts ?? []);
    } finally {
      setLoadingApproved(false);
    }
  }, []);

  useEffect(() => {
    void loadApproved();
  }, [loadApproved]);

  async function handleAnalyze(resumeText: string) {
    setAnalyzeError(null);
    setSuccessMessage(null);
    setAnalyzing(true);
    try {
      const res = await fetch("/api/resume/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeText }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAnalyzeError(data.error ?? "Something went wrong processing your resume.");
        return;
      }

      setSuccessMessage(
        data.message
          ?? `Resume profile updated with ${(data.facts ?? []).length} facts. Internship matches will refresh automatically.`,
      );
      await loadApproved();
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "Network error");
    } finally {
      setAnalyzing(false);
    }
  }

  async function updateApproved(id: string, patch: Partial<ApprovedFact>) {
    const res = await fetch(`/api/resume/facts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const data = await res.json();
      setApproved((prev) => prev.map((f) => (f.id === id ? data.fact : f)));
      setSuccessMessage("Profile updated. Internship matches will refresh automatically.");
    }
  }

  async function deleteApproved(id: string) {
    const res = await fetch(`/api/resume/facts/${id}`, { method: "DELETE" });
    if (res.ok) {
      setApproved((prev) => prev.filter((f) => f.id !== id));
      setSuccessMessage("Profile updated. Internship matches will refresh automatically.");
    }
  }

  const approvedByType = groupByType(approved);

  return (
    <div className="space-y-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Resume Profile</h1>
        <p className="text-secondary text-sm">
          Submit one resume. Internship Pilot extracts only the facts written in it and uses that
          profile to automatically score every active internship. Uploading a new resume replaces
          the previous extracted profile and refreshes your matches.
        </p>
      </header>

      <ResumeUploader onAnalyze={handleAnalyze} analyzing={analyzing} />

      {analyzeError && (
        <div className="rounded-lg bg-critical-quiet border border-critical-line text-critical text-sm px-4 py-3">
          {analyzeError}
        </div>
      )}

      {successMessage && !analyzing && (
        <div className="rounded-lg bg-verified-quiet border border-verified-line text-verified text-sm px-4 py-3">
          {successMessage}
        </div>
      )}

      <section className="space-y-4">
        <div>
          <h2 className="font-medium text-primary">Extracted resume profile</h2>
          <p className="mt-1 text-xs text-tertiary">
            These facts are the evidence used for job matching. You can correct or remove a fact;
            any change automatically refreshes affected scores.
          </p>
        </div>

        {loadingApproved ? (
          <p className="text-sm text-tertiary">Loading…</p>
        ) : approved.length === 0 ? (
          <p className="text-sm text-tertiary">
            No resume profile yet. Upload your resume above to start automatic matching.
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
          <button
            onClick={() => setEditing(false)}
            className="text-xs text-faint hover:text-secondary"
          >
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
        <button
          onClick={() => setEditing(true)}
          className="text-xs text-faint hover:text-accent-text"
        >
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
