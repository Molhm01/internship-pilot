"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";

type Check = { pass: boolean; detail?: string };
type RealInspection = { pass?: boolean; inspectedAt?: string; url?: string; enteredPersonalData?: boolean; submitted?: boolean; labelCount?: number };
type LeverInspection = { pass?: boolean; inspectedAt?: string; finalUrl?: string; enteredPersonalData?: boolean; uploadedFiles?: boolean; submitted?: boolean; fieldCount?: number; formDetected?: boolean };
type VisionPreflight = {
  pass?: boolean;
  testedAt?: string;
  ollamaVersion?: string | null;
  model?: string;
  endpoint?: string;
  image?: { width?: number; height?: number; byteSize?: number; format?: string; quality?: number };
  tests?: Record<string, { httpStatus?: number | null; validContent?: boolean; structuredOutputEnabled?: boolean; responseBody?: string }>;
};
type Payload = {
  checks: Record<string, Check>;
  mode: string;
  autoSubmitDisabled: boolean;
  lastAgentError: string | null;
  completeErrorStack: string | null;
  lastFailureScreenshot: string | null;
  currentApplicationStep: string | null;
  lastRunId: string | null;
  adapterCapabilities: Record<string, string>;
  greenhouseRealInspection: RealInspection | null;
  leverRealInspection: LeverInspection | null;
  ollamaVisionPreflight: VisionPreflight | null;
};

const LABELS: Record<string, string> = {
  playwrightInstalled: "Playwright installed", chromiumInstalled: "Chromium installed", browserCanLaunch: "Browser can launch",
  persistentBrowserProfileWritable: "Persistent browser profile writable", candidateProfileComplete: "Candidate profile complete",
  masterResumeAvailable: "Master resume available", tailoredResumeGenerated: "Tailored resume generated", coverLetterGenerated: "Cover letter generated",
  applicationQueueRunning: "Application queue running", backgroundWorkerRunning: "Background worker running",
  browserProfileOwnedByOneWorker: "Browser profile owned by one worker", duplicateRunProtection: "Duplicate-run protection",
  extensionPackageBuilt: "Chrome extension package built", extensionLoadedByWorker: "Chrome extension loaded by worker",
  visionModelAvailable: "Vision-capable Ollama model",
};

export default function AgentDiagnosticsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [testing, setTesting] = useState(false);
  const [output, setOutput] = useState("");
  const load = useCallback(async () => setData(await (await fetch("/api/agent-diagnostics")).json()), []);
  useEffect(() => { void load(); }, [load]);

  async function test() {
    setTesting(true);
    const response = await fetch("/api/agent-diagnostics/safe-test", { method: "POST" });
    const result = await response.json();
    setOutput(`${result.pass ? "PASS" : "FAIL"}\n${result.output ?? result.error}`);
    setTesting(false);
    await load();
  }

  const greenhouse = data?.greenhouseRealInspection;
  const lever = data?.leverRealInspection;
  const vision = data?.ollamaVisionPreflight;
  return <div className="max-w-5xl mx-auto px-8 py-10 space-y-6">
    <header className="flex justify-between gap-4"><div><h1 className="text-2xl font-semibold">Agent Diagnostics</h1><p className="text-sm text-slate-600">Honest runtime checks. Safe tests never submit.</p></div><button onClick={test} disabled={testing} className="rounded-lg bg-brand text-white px-4 py-2 text-sm disabled:opacity-40">{testing ? "Running safe tests..." : "Test Agent Safely"}</button></header>
    <section className="grid md:grid-cols-2 gap-3">{Object.entries(data?.checks ?? {}).map(([key, value]) => <div key={key} className="bg-white border rounded-lg p-4 flex justify-between gap-3"><div><div className="font-medium">{LABELS[key] ?? key}</div>{value.detail && <p className="text-xs text-slate-500">{value.detail}</p>}</div><strong className={value.pass ? "text-emerald-700" : "text-rose-700"}>{value.pass ? "PASS" : "FAIL"}</strong></div>)}</section>
    <section className="bg-white border rounded-xl p-5 text-sm space-y-2">
      <p><strong>Mode:</strong> {data?.mode} - AUTO_SUBMIT {data?.autoSubmitDisabled ? "disabled" : "ENABLED"}</p>
      <p><strong>Current application step:</strong> {data?.currentApplicationStep ?? "None"}</p>
      <p><strong>Last agent error:</strong> {data?.lastAgentError ?? "None"}</p>
      {data?.completeErrorStack && <details className="rounded border border-slate-200 p-3"><summary className="cursor-pointer font-medium">Show details</summary><pre className="mt-3 bg-slate-950 text-slate-100 rounded p-3 overflow-auto text-xs whitespace-pre-wrap">{data.completeErrorStack}</pre></details>}
      {data?.lastFailureScreenshot && data.lastRunId && <Image alt="Last agent failure" className="max-h-96 w-auto border" width={1280} height={900} unoptimized src={`/api/applications/${data.lastRunId}/screenshot`} />}
    </section>
    <section className="bg-white border rounded-xl p-5 text-sm space-y-1">
      <h2 className="font-semibold">Real local Ollama vision preflight</h2>
      {vision ? <>
        <p className={vision.pass ? "text-emerald-700" : "text-rose-700"}>{vision.pass ? "PASS" : "FAIL"} - Ollama {vision.ollamaVersion ?? "unknown"} - {vision.model ?? "unknown model"}</p>
        <p>Endpoint: {vision.endpoint ?? "unknown"}</p>
        <p>Screenshot: {vision.image?.width ?? "?"}×{vision.image?.height ?? "?"} {vision.image?.format ?? ""}, {vision.image?.byteSize ?? "?"} bytes, quality {vision.image?.quality ?? "?"}</p>
        <details className="rounded border border-slate-200 p-3"><summary className="cursor-pointer font-medium">Show preflight response details</summary><pre className="mt-3 bg-slate-950 text-slate-100 rounded p-3 overflow-auto text-xs whitespace-pre-wrap">{JSON.stringify(vision.tests, null, 2)}</pre></details>
      </> : <p className="text-amber-700">No real screenshot preflight has been recorded.</p>}
    </section>
    <section className="bg-white border rounded-xl p-5 text-sm space-y-1"><h2 className="font-semibold">Real public Greenhouse inspection (read-only)</h2>{greenhouse ? <><p className={greenhouse.pass ? "text-emerald-700" : "text-rose-700"}>{greenhouse.pass ? "PASS" : "FAIL"} - {greenhouse.labelCount ?? 0} labels - inspected {greenhouse.inspectedAt ?? "unknown"}</p><p>Personal data entered: {String(greenhouse.enteredPersonalData)} - submitted: {String(greenhouse.submitted)}</p>{greenhouse.url && <a className="text-brand hover:underline" href={greenhouse.url} target="_blank" rel="noopener noreferrer">Inspected public page</a>}</> : <p className="text-amber-700">No real-page inspection report has been recorded.</p>}</section>
    <section className="bg-white border rounded-xl p-5 text-sm space-y-1"><h2 className="font-semibold">Real public Lever navigation (read-only)</h2>{lever ? <><p className={lever.pass ? "text-emerald-700" : "text-rose-700"}>{lever.pass ? "PASS" : "FAIL"} - {lever.fieldCount ?? 0} fields - inspected {lever.inspectedAt ?? "unknown"}</p><p>Form detected: {String(lever.formDetected)} - personal data entered: {String(lever.enteredPersonalData)} - files uploaded: {String(lever.uploadedFiles)} - submitted: {String(lever.submitted)}</p>{lever.finalUrl && <a className="text-brand hover:underline" href={lever.finalUrl} target="_blank" rel="noopener noreferrer">Inspected form URL</a>}</> : <p className="text-amber-700">No real Lever navigation report has been recorded.</p>}</section>
    <section className="bg-white border rounded-xl p-5"><h2 className="font-semibold mb-3">ATS compatibility</h2><div className="grid md:grid-cols-3 gap-2 text-sm">{Object.entries(data?.adapterCapabilities ?? {}).map(([ats, status]) => <div key={ats} className="border rounded p-3"><strong className="capitalize">{ats}</strong><div className={status === "PRODUCTION_FILL_TESTED" || status === "PRODUCTION_INSPECTED" ? "text-emerald-700" : "text-amber-700"}>{status}</div></div>)}</div></section>
    {output && <pre className="bg-slate-950 text-slate-100 rounded-xl p-4 overflow-auto text-xs whitespace-pre-wrap">{output}</pre>}
  </div>;
}
