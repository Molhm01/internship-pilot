"use client";

import { useCallback, useEffect, useState } from "react";

type ImportStatus = { ran: boolean; reason?: string; sourceFilename: string; expectedRows: number; importedRows: number; rejectedRows: number; duplicateRows: number; errors: string[]; lastImportTime: string };
type Employer = { id: string; name: string; careersUrl: string | null; csvSector: string | null; csvCareerDomain: string | null; csvEeCpeFit: string | null; csvVerificationStatus: string | null; csvVerifiedDate: string | null; csvRecommendedSearchTerms: string | null; lastCheckedAt: string | null; monitoringStatus: string; portalStatus: string; currentlyVerifiedInternshipOpenings: number };
type Payload = { fileExists: boolean; importStatus: ImportStatus; total: number; expectedTotal: number; page: number; pageCount: number; sectors: string[]; employers: Employer[] };

export default function ApprovedEmployersPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [search, setSearch] = useState("");
  const [sector, setSector] = useState("");
  const [fit, setFit] = useState("");
  const [page, setPage] = useState(1);
  const [importing, setImporting] = useState(false);
  const load = useCallback(async () => {
    const query = new URLSearchParams({ search, sector, fit, page: String(page), pageSize: "25" });
    const response = await fetch(`/api/approved-employers?${query}`);
    setData(await response.json());
  }, [search, sector, fit, page]);
  useEffect(() => { load(); }, [load]);
  async function runImport() { setImporting(true); await fetch("/api/approved-employers", { method: "POST" }); await load(); setImporting(false); }
  const status = data?.importStatus;
  return <div className="max-w-[1500px] mx-auto px-8 py-10 space-y-6">
    <header className="flex items-start justify-between gap-4">
      <div><h1 className="text-2xl font-semibold">497 Approved Engineering Employers</h1><p className="text-sm text-secondary">Approved portals and live jobs are separate trust states. <strong>APPROVED_OFFICIAL_PORTAL</strong> allowlists an employer portal; <strong>LIVE_JOB_VERIFIED</strong> means one exact internship was confirmed open there.</p></div>
      <button onClick={runImport} disabled={importing} className="rounded-lg bg-accent text-white px-4 py-2.5 text-sm disabled:opacity-40">{importing ? "Importing…" : "Import CSV"}</button>
    </header>
    {status && <section className={`rounded-lg border p-5 ${data?.fileExists && status.ran ? "bg-verified-quiet border-verified-line" : "bg-critical-quiet border-critical-line"}`}>
      <h2 className="font-semibold">Import status</h2>
      {!data?.fileExists && <p className="font-medium text-critical mt-2">Required CSV is missing. No demo or mock employers are substituted.</p>}
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-sm"><Metric label="Source filename" value={status.sourceFilename}/><Metric label="Expected rows" value={status.expectedRows}/><Metric label="Imported rows" value={status.importedRows}/><Metric label="Rejected rows" value={status.rejectedRows}/><Metric label="Duplicate rows" value={status.duplicateRows}/><Metric label="Last import time" value={new Date(status.lastImportTime).getTime() ? new Date(status.lastImportTime).toLocaleString() : "Never"}/></dl>
      {status.errors?.length > 0 && <ul className="mt-3 text-xs text-critical list-disc pl-5">{status.errors.map((error) => <li key={error}>{error}</li>)}</ul>}
    </section>}
    <section className="bg-surface rounded-lg border border-hairline p-4 grid md:grid-cols-3 gap-3">
      <input aria-label="Search employers" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} className="input" placeholder="Search employer…"/>
      <select aria-label="Filter by sector" value={sector} onChange={(event) => { setSector(event.target.value); setPage(1); }} className="input"><option value="">All sectors</option>{data?.sectors.map((value) => <option key={value} value={value}>{value}</option>)}</select>
      <select aria-label="Filter by EE/CPE fit" value={fit} onChange={(event) => { setFit(event.target.value); setPage(1); }} className="input"><option value="">All EE/CPE fits</option><option value="High">High</option><option value="Medium">Medium</option><option value="Low">Low</option></select>
    </section>
    <div className="bg-surface rounded-lg border border-hairline overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-left uppercase text-tertiary border-b">{["Employer","Sector","Official career website","Career domain","EE/CPE fit","Portal status","Last curated","Search terms","Last checked","Live internships","Monitoring"].map((h)=><th key={h} className="p-3">{h}</th>)}</tr></thead><tbody>{data?.employers.map((e)=><tr key={e.id} className="border-b last:border-0 align-top"><td className="p-3 font-medium">{e.name}</td><td className="p-3">{e.csvSector ?? "—"}</td><td className="p-3">{e.careersUrl ? <a className="text-accent-text hover:underline" href={e.careersUrl} target="_blank" rel="noreferrer">Official careers ↗</a> : "Missing"}</td><td className="p-3">{e.csvCareerDomain ?? "—"}</td><td className="p-3">{e.csvEeCpeFit ?? "—"}</td><td className="p-3"><span className="font-medium text-verified">{e.portalStatus}</span></td><td className="p-3">{e.csvVerifiedDate ? new Date(e.csvVerifiedDate).toLocaleDateString() : "—"}</td><td className="p-3 max-w-64">{e.csvRecommendedSearchTerms ?? "—"}</td><td className="p-3">{e.lastCheckedAt ? new Date(e.lastCheckedAt).toLocaleString() : "Never"}</td><td className="p-3 font-semibold">{e.currentlyVerifiedInternshipOpenings}</td><td className="p-3 capitalize">{e.monitoringStatus}</td></tr>)}</tbody></table>{data && data.employers.length === 0 && <p className="p-6 text-sm text-tertiary">No approved employers imported.</p>}</div>
    <footer className="flex justify-between items-center text-sm"><span>{data?.total ?? 0} matching employers</span><div className="flex gap-2"><button className="border rounded px-3 py-1 disabled:opacity-40" disabled={page <= 1} onClick={()=>setPage(page-1)}>Previous</button><span>Page {page} of {data?.pageCount ?? 1}</span><button className="border rounded px-3 py-1 disabled:opacity-40" disabled={page >= (data?.pageCount ?? 1)} onClick={()=>setPage(page+1)}>Next</button></div></footer>
  </div>;
}
function Metric({label,value}:{label:string;value:string|number}) { return <div><dt className="text-tertiary">{label}</dt><dd className="font-medium break-words">{value}</dd></div>; }
