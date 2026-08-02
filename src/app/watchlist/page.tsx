"use client";

import { useCallback, useEffect, useState } from "react";

type Company = {
  id: string;
  name: string;
  industry: string | null;
  website: string | null;
  careersUrl: string | null;
  atsType: string | null;
  atsIdentifier: string | null;
  priority: string;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  activeInternshipCount: number;
  monitoringStatus: string;
  lastCheckStatus: string | null;
  lastCheckError: string | null;
  source: string;
  allowlisted: boolean;
  csvVerificationBasis: string | null;
};

const emptyForm = { name: "", industry: "", website: "", careersUrl: "", priority: "standard" };

const ATS_LABELS: Record<string, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  smartrecruiters: "SmartRecruiters",
  workday: "Workday",
  icims: "iCIMS",
  taleo: "Taleo",
  successfactors: "SuccessFactors",
  usajobs: "USAJOBS",
  custom: "Custom / manual check",
  unknown: "Not yet detected",
};

export default function WatchlistPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/companies");
    const data = await res.json();
    setCompanies(data.companies ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        setForm(emptyForm);
        setShowForm(false);
        await load();
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function checkNow(id: string) {
    setCheckingId(id);
    setCheckResult(null);
    try {
      const res = await fetch(`/api/companies/${id}/check`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setCheckResult(
          `${data.result.name}: ${data.result.status} — ${data.result.newCount} new, ${data.result.updatedCount} updated`,
        );
        await load();
      } else {
        setCheckResult(`Error: ${data.error}`);
      }
    } finally {
      setCheckingId(null);
    }
  }

  async function togglePause(company: Company) {
    const next = company.monitoringStatus === "active" ? "paused" : "active";
    setCompanies((prev) => prev.map((c) => (c.id === company.id ? { ...c, monitoringStatus: next } : c)));
    await fetch(`/api/companies/${company.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ monitoringStatus: next }),
    });
  }

  async function approveForDiscovery(company: Company) {
    setCompanies((prev) => prev.map((c) => (c.id === company.id ? { ...c, allowlisted: true } : c)));
    await fetch(`/api/companies/${company.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowlisted: true }),
    });
  }

  return (
    <div className="max-w-6xl mx-auto px-8 py-10 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Company Watchlist</h1>
          <p className="text-slate-600 text-sm">
            Every employer whose official career page we check on a schedule. Discovery is
            strictly limited to two sources: <code>approved_engineering_employers.csv</code> and
            Intern List. Anything else (like a Nearby Firms result) stays inactive until you
            explicitly approve it below.
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2.5 hover:bg-brand-dark transition-colors"
        >
          {showForm ? "Close form" : "+ Add company"}
        </button>
      </header>

      {checkResult && (
        <div className="rounded-lg bg-slate-100 border border-slate-200 text-slate-700 text-sm px-4 py-3">
          {checkResult}
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Company name *">
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input" />
            </Field>
            <Field label="Industry">
              <input value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} className="input" />
            </Field>
            <Field label="Official website">
              <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} className="input" placeholder="https://…" />
            </Field>
            <Field label="Careers URL">
              <input value={form.careersUrl} onChange={(e) => setForm({ ...form, careersUrl: e.target.value })} className="input" placeholder="https://…/careers" />
            </Field>
            <Field label="Priority">
              <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className="input">
                <option value="priority">Priority (checked every 5 min)</option>
                <option value="standard">Standard (staggered 15-30 min)</option>
                <option value="low">Low (daily)</option>
              </select>
            </Field>
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2.5 disabled:opacity-40 hover:bg-brand-dark transition-colors"
          >
            {submitting ? "Saving…" : "Add to Watchlist"}
          </button>
        </form>
      )}

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Company</th>
                <th className="px-4 py-3">ATS</th>
                <th className="px-4 py-3">Priority</th>
                <th className="px-4 py-3">Last checked</th>
                <th className="px-4 py-3">Active internships</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Discovery</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-800">{c.name}</p>
                    <p className="text-xs text-slate-400">{c.industry}</p>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{ATS_LABELS[c.atsType ?? "unknown"] ?? c.atsType}</td>
                  <td className="px-4 py-3 text-slate-600 capitalize">{c.priority}</td>
                  <td className="px-4 py-3 text-slate-500 text-xs">
                    {c.lastCheckedAt ? new Date(c.lastCheckedAt).toLocaleString() : "never"}
                  </td>
                  <td className="px-4 py-3 text-slate-800 font-medium">{c.activeInternshipCount}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs rounded-full px-2 py-1 border ${
                        c.monitoringStatus === "paused"
                          ? "bg-slate-100 text-slate-500 border-slate-300"
                          : c.lastCheckStatus === "error"
                            ? "bg-rose-100 text-rose-700 border-rose-300"
                            : c.lastCheckStatus === "unsupported"
                              ? "bg-amber-100 text-amber-700 border-amber-300"
                              : "bg-emerald-100 text-emerald-700 border-emerald-300"
                      }`}
                      title={c.lastCheckError ?? undefined}
                    >
                      {c.monitoringStatus === "paused" ? "Paused" : (c.lastCheckStatus ?? "not checked yet")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {c.allowlisted ? (
                      <span className="text-xs rounded-full px-2 py-1 border bg-emerald-100 text-emerald-700 border-emerald-300">
                        Allowed ({c.source})
                      </span>
                    ) : (
                      <button
                        onClick={() => approveForDiscovery(c)}
                        className="text-xs rounded-full px-2 py-1 border bg-amber-100 text-amber-700 border-amber-300 hover:bg-amber-200"
                        title="Not from the CSV or Intern List — approve to activate scheduled checking"
                      >
                        Approve for discovery
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button
                      onClick={() => checkNow(c.id)}
                      disabled={checkingId === c.id}
                      className="text-xs text-brand hover:underline mr-3 disabled:opacity-40"
                    >
                      {checkingId === c.id ? "Checking…" : "Check now"}
                    </button>
                    <button onClick={() => togglePause(c)} className="text-xs text-slate-400 hover:text-slate-700">
                      {c.monitoringStatus === "active" ? "Pause" : "Resume"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      {children}
    </label>
  );
}
