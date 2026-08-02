"use client";

import { useEffect, useState, useCallback } from "react";
import OllamaStatusBadge from "@/components/OllamaStatusBadge";
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

type CandidateFact = {
  key: string;
  type: FactType;
  content: string;
  detail: string;
  included: boolean;
};

export default function ResumeFactsSection() {
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CandidateFact[]>([]);
  const [saving, setSaving] = useState(false);

  const [approved, setApproved] = useState<ApprovedFact[]>([]);
  const [loadingApproved, setLoadingApproved] = useState(true);

  const loadApproved = useCallback(async () => {
    setLoadingApproved(true);
    const res = await fetch("/api/resume/facts?status=approved");
    const data = await res.json();
    setApproved(data.facts ?? []);
    setLoadingApproved(false);
  }, []);

  useEffect(() => {
    loadApproved();
  }, [loadApproved]);

  async function handleAnalyze(resumeText: string) {
    setAnalyzeError(null);
    setAnalyzing(true);
    setCandidates([]);
    try {
      const res = await fetch("/api/resume/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeText }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAnalyzeError(data.error ?? "Something went wrong analyzing your resume.");
        return;
      }
      const facts: CandidateFact[] = data.facts.map(
        (f: { type: FactType; content: string; detail?: string | null }, i: number) => ({
          key: `${f.type}-${i}-${Date.now()}`,
          type: f.type,
          content: f.content,
          detail: f.detail ?? "",
          included: true,
        }),
      );
      setCandidates(facts);
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "Network error");
    } finally {
      setAnalyzing(false);
    }
  }

  function updateCandidate(key: string, patch: Partial<CandidateFact>) {
    setCandidates((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }

  function discardCandidate(key: string) {
    setCandidates((prev) => prev.filter((c) => c.key !== key));
  }

  const includedCount = candidates.filter((c) => c.included).length;

  async function handleSaveApproved() {
    const toSave = candidates.filter((c) => c.included);
    if (toSave.length === 0) return;
    setSaving(true);
    try {
      const res = await fetch("/api/resume/facts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          facts: toSave.map((c) => ({
            type: c.type,
            content: c.content,
            detail: c.detail || null,
            source: "ai",
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAnalyzeError(data.error ?? "Could not save facts.");
        return;
      }
      setCandidates([]);
      await loadApproved();
    } finally {
      setSaving(false);
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
    <div className="space-y-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Profile</h1>
        <p className="text-slate-600 text-sm">
          Upload your resume as a PDF, let the local AI model pull out facts, then review each one
          before it&apos;s saved. Nothing is trusted until you approve it.
        </p>
        <OllamaStatusBadge />
      </header>

      <ResumeUploader onAnalyze={handleAnalyze} analyzing={analyzing} />
      {analyzeError && (
        <div className="rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-3">
          {analyzeError}
        </div>
      )}

      {candidates.length > 0 && (
        <section className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-medium text-slate-900">
              2. Review extracted facts ({includedCount} selected)
            </h2>
            <button
              onClick={handleSaveApproved}
              disabled={saving || includedCount === 0}
              className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2 disabled:opacity-40 hover:bg-brand-dark transition-colors"
            >
              {saving ? "Saving…" : `Save ${includedCount} approved fact${includedCount === 1 ? "" : "s"}`}
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Uncheck anything wrong, edit the text inline, or discard it entirely. Only checked
            facts are saved.
          </p>
          <div className="space-y-2">
            {candidates.map((c) => (
              <div
                key={c.key}
                className={`flex items-start gap-3 rounded-lg border p-3 ${
                  c.included ? "border-slate-200 bg-slate-50" : "border-slate-100 bg-white opacity-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={c.included}
                  onChange={(e) => updateCandidate(c.key, { included: e.target.checked })}
                  className="mt-1.5 accent-[var(--brand)]"
                />
                <div className="flex-1 space-y-1.5">
                  <span className="inline-block text-[10px] uppercase tracking-wide font-semibold text-brand bg-brand/10 rounded px-1.5 py-0.5">
                    {FACT_TYPE_LABELS[c.type] ?? c.type}
                  </span>
                  <input
                    value={c.content}
                    onChange={(e) => updateCandidate(c.key, { content: e.target.value })}
                    className="w-full text-sm font-medium bg-transparent border-b border-transparent hover:border-slate-300 focus:border-brand focus:outline-none py-0.5"
                  />
                  <input
                    value={c.detail}
                    onChange={(e) => updateCandidate(c.key, { detail: e.target.value })}
                    placeholder="Optional supporting detail"
                    className="w-full text-xs text-slate-500 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-brand focus:outline-none py-0.5"
                  />
                </div>
                <button
                  onClick={() => discardCandidate(c.key)}
                  className="text-xs text-slate-400 hover:text-rose-600 px-2 py-1"
                  title="Discard this fact"
                >
                  Discard
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-4">
        <h2 className="font-medium text-slate-900">Approved facts</h2>
        {loadingApproved ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : approved.length === 0 ? (
          <p className="text-sm text-slate-500">
            No approved facts yet. Analyze your resume above to get started.
          </p>
        ) : (
          <div className="space-y-6">
            {Object.entries(approvedByType).map(([type, facts]) => (
              <div key={type}>
                <h3 className="text-xs uppercase tracking-wide font-semibold text-slate-500 mb-2">
                  {FACT_TYPE_LABELS[type as FactType] ?? type} ({facts.length})
                </h3>
                <div className="space-y-2">
                  {facts.map((f) => (
                    <ApprovedFactRow
                      key={f.id}
                      fact={f}
                      onSave={(patch) => updateApproved(f.id, patch)}
                      onDelete={() => deleteApproved(f.id)}
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
      <div className="flex items-start gap-3 rounded-lg border border-brand/40 bg-brand/5 p-3">
        <div className="flex-1 space-y-1.5">
          <input
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full text-sm font-medium bg-white border border-slate-300 rounded px-2 py-1 focus:outline-none focus:border-brand"
          />
          <input
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="Optional supporting detail"
            className="w-full text-xs bg-white border border-slate-300 rounded px-2 py-1 focus:outline-none focus:border-brand"
          />
        </div>
        <div className="flex flex-col gap-1">
          <button onClick={save} className="text-xs font-medium text-brand hover:underline">
            Save
          </button>
          <button
            onClick={() => setEditing(false)}
            className="text-xs text-slate-400 hover:text-slate-600"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 group">
      <div className="flex-1">
        <p className="text-sm font-medium text-slate-800">{fact.content}</p>
        {fact.detail && <p className="text-xs text-slate-500">{fact.detail}</p>}
      </div>
      <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={() => setEditing(true)}
          className="text-xs text-slate-400 hover:text-brand"
        >
          Edit
        </button>
        <button onClick={onDelete} className="text-xs text-slate-400 hover:text-rose-600">
          Delete
        </button>
      </div>
    </div>
  );
}

function groupByType(facts: ApprovedFact[]): Record<string, ApprovedFact[]> {
  const groups: Record<string, ApprovedFact[]> = {};
  for (const f of facts) {
    if (!groups[f.type]) groups[f.type] = [];
    groups[f.type].push(f);
  }
  return groups;
}
