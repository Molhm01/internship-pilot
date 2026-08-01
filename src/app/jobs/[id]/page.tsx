"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import StatusSelector from "@/components/StatusSelector";
import MatchScoreBadge from "@/components/MatchScoreBadge";
import SkillBucket, { SkillItem } from "@/components/SkillBucket";
import OllamaStatusBadge from "@/components/OllamaStatusBadge";
import VerificationBadge from "@/components/VerificationBadge";
import {
  openStoredApplicationUrl,
  selectStoredApplicationLinks,
} from "@/lib/jobs/applicationUrl";
import { hasUsableJobDescription, requestManualMatch } from "@/lib/matchWorkflow";

type MatchResultRaw = {
  id: string;
  eligibility: string;
  eligibilityReason: string;
  score: number;
  explanation: string;
  recommendation: string;
  skillsSupported: string;
  skillsNeedConfirmation: string;
  skillsToLearn: string;
  skillsNeverAdd: string;
  tailoringPreview: string | null;
  createdAt: string;
};

type Job = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  postingDate: string | null;
  internshipTerm: string | null;
  duration: string | null;
  url: string | null;
  sourceListingUrl: string | null;
  officialApplicationUrl: string | null;
  originalJobPostUrl: string | null;
  resolutionStatus: string;
  resolutionMethod: string | null;
  resolvedAt: string | null;
  resolutionError: string | null;
  officialApplyUrl: string | null;
  officialJobUrl: string | null;
  jobDescriptionSourceUrl: string | null;
  redirectChain: string | null;
  sourceUrl: string | null;
  source: string | null;
  workplaceType: string | null;
  compensation: string | null;
  description: string;
  jobResponsibilities: string | null;
  jobQualifications: string | null;
  status: string;
  verificationStatus: string;
  verificationReason: string | null;
  verificationMethod: string | null;
  officialEmployerDomain: string | null;
  requisitionId: string | null;
  evidence: string | null;
  lastVerifiedAt: string | null;
  matchResults: MatchResultRaw[];
};

type GeneratedDoc = {
  id: string;
  type: string;
  version: number;
  qaStatus: string;
  qaIssues: string | null;
  keywordClassification: string | null;
  tailoringStatus: string | null;
  tailoringAudit: string | null;
  identityVerified: boolean;
  createdAt: string;
};

type ApplicationRun = {
  id: string;
  mode: string;
  atsType: string;
  status: string;
  needsUserActionReason: string | null;
  stoppedFieldLabel: string | null;
  stoppedFieldType: string | null;
  stoppedFieldOptions: string | null;
  stoppedFieldStep: number | null;
  stoppedFieldContext: string | null;
  currentStep: string | null;
  documentStrategy: string | null;
  documentStrategyReason: string | null;
  confirmationNumber: string | null;
  confirmationUrl: string | null;
  screenshotPath: string | null;
  errorLog: string | null;
  createdAt: string;
  finishedAt: string | null;
};

const REUSABLE_STOP_REASONS = new Set([
  "unknown_question",
  "essay_without_approved_answer",
  "requested_info_not_stored",
  "citizenship_clearance_sponsorship_ambiguous",
  "eeo_no_saved_preference",
  "terms_confirmation_required",
  "conflicting_data",
]);

type AuditEntry = {
  id: string;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
};

const ACTOR_LABELS: Record<string, string> = {
  "ai-match": "AI Match",
  verification: "Verification",
  "document-generation": "Document Generation",
  "application-agent": "Application Agent",
  "gmail-tracking": "Gmail Tracking",
  user: "You",
};

const STOP_REASON_LABELS: Record<string, string> = {
  captcha: "Complete the CAPTCHA in the application browser, then click Resume.",
  mfa: "Complete MFA in the application browser, then click Resume.",
  login_required: "Log in in the application browser, then click Resume.",
  assessment_required: "This application requires completing a hiring assessment.",
  unknown_question: "The form asked a question with no confident, grounded answer.",
  essay_without_approved_answer: "A free-text essay question had no pre-approved answer.",
  citizenship_clearance_sponsorship_ambiguous: "A citizenship/sponsorship/clearance question has no saved answer in your Application Profile.",
  eeo_no_saved_preference: "An EEO/demographic question has no saved preference in your Application Profile.",
  requested_info_not_stored: "The form asked for information not stored in your profile or facts.",
  conflicting_data: "A dropdown had no option matching your stored answer.",
  upload_failed: "A file (resume or cover letter) failed to upload.",
  terms_confirmation_required: "The form requires confirming terms/certifications that need your review.",
  unsupported_ats: "This employer's application platform isn't supported for autofill yet.",
  form_not_found: "The application form or a confirmation message could not be located.",
  duplicate_requisition: "An application to this exact requisition already exists.",
};

function parseSkills(json: string): SkillItem[] {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function parseStrings(json: string | null): string[] {
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function friendlyRunError(error: string): string {
  if (/launchPersistentContext|profile is already in use|existing browser session/i.test(error)) {
    return "The application browser was busy. The background worker will handle browser access without opening a competing session.";
  }
  if (/BROWSER_RESTART_FAILED|Target page, context or browser has been closed|browser.*disconnected/i.test(error)) {
    return "The worker-owned application browser closed and could not be restarted for this run.";
  }
  if (/Ollama|Vision model request failed/i.test(error)) {
    return "The local vision request failed. You can retry this same run after the Ollama check passes.";
  }
  if (/timeout/i.test(error)) return "The application page took too long to respond.";
  return "The application worker could not finish this run.";
}

function displayRunState(run: ApplicationRun): string {
  if (run.status === "queued") return "QUEUED";
  if (run.status === "needs_user_action") return "NEEDS USER ACTION";
  if (run.status === "filled") return "FINAL REVIEW";
  if (run.status === "submitted" || run.status === "completed") return "COMPLETED";
  if (run.status === "failed") return "FAILED";
  if (run.status === "running") {
    return ["STARTING_BROWSER", "NAVIGATING", "FILLING"].includes(run.currentStep ?? "")
      ? (run.currentStep ?? "FILLING").replace(/_/g, " ")
      : "FILLING";
  }
  return run.status.replace(/_/g, " ").toUpperCase();
}

function GeneratedDocumentCard({ document }: { document: GeneratedDoc }) {
  const issues = parseStrings(document.qaIssues);
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-medium text-slate-800 capitalize">
          {document.type === "coverLetter" ? "Cover letter" : "Resume"} (v{document.version})
        </span>
        <span className={`text-xs rounded-full border px-2 py-1 ${
          document.qaStatus === "pass" && document.identityVerified
            ? "bg-emerald-100 text-emerald-700 border-emerald-300"
            : "bg-rose-100 text-rose-700 border-rose-300"
        }`}>
          {document.qaStatus === "INVALID_TEST_DATA" ? "INVALID TEST DATA" : `QA ${document.qaStatus}`}
        </span>
      </div>
      <a
        href={`/api/documents/${document.id}/download`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-brand hover:underline"
      >
        Open PDF ↗
      </a>
      {issues.length > 0 && (
        <ul className="text-xs text-amber-700 list-disc list-inside">
          {issues.map((issue, index) => <li key={index}>{issue}</li>)}
        </ul>
      )}
      {document.type === "resume" && document.tailoringStatus && (
        <p className="text-xs font-medium text-slate-700">{document.tailoringStatus}</p>
      )}
      {document.type === "resume" && document.tailoringAudit && (() => {
        try {
          const audit = JSON.parse(document.tailoringAudit) as {
            originalAtsMatchScore: number;
            tailoredAtsMatchScore: number;
            keywordsAdded: string[];
            bulletsChanged: Array<{ original: string; tailored: string; evidence: Array<{ factId: string; content: string }> }>;
            bulletsReordered?: Array<{ entry: string; before: string[]; after: string[] }>;
            supportedKeywords: Array<{ keyword: string; evidence: Array<{ factId: string; content: string }> }>;
            unsupportedRequirementsNotAdded: string[];
          };
          return (
            <details className="text-xs rounded border border-slate-200 p-2">
              <summary className="cursor-pointer font-medium">Tailoring Audit</summary>
              <div className="mt-2 space-y-2">
                <p>Original ATS match: {audit.originalAtsMatchScore} · Tailored ATS match: {audit.tailoredAtsMatchScore}</p>
                <p><strong>Keywords added:</strong> {audit.keywordsAdded.length ? audit.keywordsAdded.join(", ") : "None"}</p>
                <div><strong>Exact bullets changed:</strong>{audit.bulletsChanged.length ? <ul className="list-disc pl-4">{audit.bulletsChanged.map((change, index) => <li key={index}><span className="line-through">{change.original}</span><br />→ {change.tailored}<br /><span className="text-slate-500">Evidence: {change.evidence.map((item) => `${item.content} (${item.factId})`).join("; ")}</span></li>)}</ul> : " None"}</div>
                <div><strong>Bullet order changes:</strong>{audit.bulletsReordered?.length ? <ul className="list-disc pl-4">{audit.bulletsReordered.map((change) => <li key={change.entry}>{change.entry}: {change.after.map((bullet, index) => `${index + 1}. ${bullet}`).join(" ")}</li>)}</ul> : " None"}</div>
                <div><strong>Supported keywords:</strong><ul className="list-disc pl-4">{audit.supportedKeywords.map((item) => <li key={item.keyword}>{item.keyword}: {item.evidence.map((fact) => fact.content).join("; ")}</li>)}</ul></div>
                <div><strong>Intentionally not added:</strong><ul className="list-disc pl-4">{audit.unsupportedRequirementsNotAdded.map((item) => <li key={item}>{item}</li>)}</ul></div>
              </div>
            </details>
          );
        } catch {
          return <p className="text-xs text-amber-700">Tailoring audit metadata is unreadable.</p>;
        }
      })()}
    </div>
  );
}

const RECOMMENDATION_STYLE: Record<string, string> = {
  Apply: "bg-emerald-50 border-emerald-200 text-emerald-800",
  Skip: "bg-rose-50 border-rose-200 text-rose-800",
  Consider: "bg-amber-50 border-amber-200 text-amber-800",
};

export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [documents, setDocuments] = useState<GeneratedDoc[]>([]);
  const [generatingDocs, setGeneratingDocs] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [runs, setRuns] = useState<ApplicationRun[]>([]);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [answerReuse, setAnswerReuse] = useState<Record<string, boolean>>({});
  const [savingAnswerId, setSavingAnswerId] = useState<string | null>(null);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/jobs/${id}`);
    if (res.status === 404) {
      setJob(null);
      setLoading(false);
      return;
    }
    const data = await res.json();
    setJob(data.job);
    setLoading(false);
  }, [id]);

  const loadDocuments = useCallback(async () => {
    const res = await fetch(`/api/jobs/${id}/documents`);
    if (res.ok) {
      const data = await res.json();
      setDocuments(data.documents ?? []);
    }
  }, [id]);

  const loadRuns = useCallback(async () => {
    const res = await fetch(`/api/jobs/${id}/applications`);
    if (res.ok) {
      const data = await res.json();
      setRuns(data.runs ?? []);
    }
  }, [id]);

  const loadAuditLog = useCallback(async () => {
    const res = await fetch(`/api/jobs/${id}/audit-log`);
    if (res.ok) {
      const data = await res.json();
      setAuditLog(data.entries ?? []);
    }
  }, [id]);

  useEffect(() => {
    load();
    loadDocuments();
    loadRuns();
    loadAuditLog();
  }, [load, loadDocuments, loadRuns, loadAuditLog]);

  function applyToJob() {
    if (job) openStoredApplicationUrl(job);
  }

  async function saveAnswerAndRetry(runId: string) {
    const answer = (answerDrafts[runId] ?? "").trim();
    if (!answer) return;
    setSavingAnswerId(runId);
    try {
      const res = await fetch(`/api/applications/${runId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer, reuse: answerReuse[runId] === true }),
      });
      if (res.ok) {
        await Promise.all([loadRuns(), load(), loadAuditLog()]);
      }
    } finally {
      setSavingAnswerId(null);
    }
  }

  async function resumePausedRun(runId: string) {
    setSavingAnswerId(runId);
    try {
      const response = await fetch(`/api/applications/${runId}/resume`, { method: "POST" });
      if (response.ok) await Promise.all([loadRuns(), load(), loadAuditLog()]);
    } finally {
      setSavingAnswerId(null);
    }
  }

  const validDocuments = documents.filter((document) =>
    document.qaStatus === "pass"
    && document.identityVerified,
  );
  const newestValidDocuments = ["resume", "coverLetter"]
    .map((type) => validDocuments.find((document) => document.type === type))
    .filter((document): document is GeneratedDoc => Boolean(document));
  const newestValidIds = new Set(newestValidDocuments.map((document) => document.id));
  const previousValidDocuments = validDocuments.filter((document) => !newestValidIds.has(document.id));
  const archivedInvalidDocuments = documents.filter((document) => !validDocuments.some((valid) => valid.id === document.id));

  useEffect(() => {
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) return;
    const timer = window.setInterval(() => {
      void Promise.all([loadRuns(), load(), loadAuditLog()]);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [runs, loadRuns, load, loadAuditLog]);

  async function generateDocuments() {
    setGeneratingDocs(true);
    setDocError(null);
    try {
      const res = await fetch(`/api/jobs/${id}/generate-documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeCoverLetter: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDocError(data.error ?? "Could not generate documents.");
        return;
      }
      await Promise.all([loadDocuments(), loadAuditLog()]);
    } catch (error) {
      setDocError(error instanceof Error ? error.message : "Could not generate documents.");
    } finally {
      setGeneratingDocs(false);
    }
  }

  async function runMatch() {
    setMatchError(null);
    setMatching(true);
    try {
      await requestManualMatch(id);
      await Promise.all([load(), loadAuditLog()]);
    } catch (error) {
      setMatchError(error instanceof Error ? error.message : "Could not run match.");
    } finally {
      setMatching(false);
    }
  }

  async function reverify() {
    setVerifying(true);
    try {
      await fetch(`/api/jobs/${id}/verify`, { method: "POST" });
      await Promise.all([load(), loadAuditLog()]);
    } finally {
      setVerifying(false);
    }
  }

  async function changeStatus(status: string) {
    if (!job) return;
    setJob({ ...job, status });
    await fetch(`/api/jobs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  }

  async function deleteJob() {
    if (!confirm("Delete this job and its match history?")) return;
    await fetch(`/api/jobs/${id}`, { method: "DELETE" });
    router.push("/jobs");
  }

  if (loading) {
    return <div className="max-w-4xl mx-auto px-8 py-10 text-sm text-slate-500">Loading…</div>;
  }

  if (!job) {
    return (
      <div className="max-w-4xl mx-auto px-8 py-10">
        <p className="text-sm text-slate-500">Job not found.</p>
        <Link href="/jobs" className="text-brand text-sm hover:underline">
          Back to jobs
        </Link>
      </div>
    );
  }

  const latestMatch = job.matchResults[0];
  const canRunMatch = hasUsableJobDescription(job);
  const tailoring = parseStrings(latestMatch?.tailoringPreview ?? null);
  const { applicationUrl, sourceListingUrl } = selectStoredApplicationLinks(job);

  return (
    <div className="max-w-4xl mx-auto px-8 py-10 space-y-8">
      <Link href="/jobs" className="text-sm text-slate-500 hover:text-brand">
        ← Back to jobs
      </Link>

      <header className="bg-white rounded-xl border border-slate-200 p-6 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">{job.title}</h1>
            <p className="text-slate-600">{job.company}</p>
          </div>
          <StatusSelector value={job.status} onChange={changeStatus} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
          {job.location && <span>📍 {job.location}</span>}
          {job.workplaceType && <span>{job.workplaceType}</span>}
          {job.internshipTerm && <span>🗓 {job.internshipTerm}</span>}
          {job.duration && <span>⏱ {job.duration}</span>}
          {job.compensation && <span>💵 {job.compensation}</span>}
          {job.postingDate && <span>Posted {new Date(job.postingDate).toLocaleDateString()}</span>}
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <VerificationBadge status={job.verificationStatus} />
          {job.source && (
            <span className="text-xs text-slate-400">
              Discovered via {job.source === "intern-list" ? "Intern List" : job.source}
            </span>
          )}
          <button
            onClick={reverify}
            disabled={verifying}
            className="text-xs text-brand hover:underline disabled:opacity-40"
          >
            {verifying ? "Re-checking…" : "Re-verify now"}
          </button>
        </div>
        {job.verificationReason && (
          <p className="text-xs text-slate-500">{job.verificationReason}</p>
        )}
        {job.lastVerifiedAt && (
          <p className="text-xs text-slate-400">
            Last verified {new Date(job.lastVerifiedAt).toLocaleString()}. This reflects the most
            recent check only — not a permanent or guaranteed status.
          </p>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-400">
          {job.officialEmployerDomain && <span>Official domain: {job.officialEmployerDomain}</span>}
          {job.requisitionId && <span>Requisition ID: {job.requisitionId}</span>}
          {job.verificationMethod && <span>Method: {job.verificationMethod}</span>}
        </div>
        {job.evidence && (
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer hover:text-brand">Show verification evidence</summary>
            <pre className="mt-2 whitespace-pre-wrap bg-slate-50 rounded-lg p-3 text-[11px]">
              {JSON.stringify(JSON.parse(job.evidence), null, 2)}
            </pre>
          </details>
        )}

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs pt-1">
          {applicationUrl && (
            <a href={applicationUrl} target="_blank" rel="noopener noreferrer" className="text-brand font-medium hover:underline">
              Official application ↗
            </a>
          )}
          {!applicationUrl && sourceListingUrl && (
            <a href={sourceListingUrl} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:underline">
              Open source listing ↗
            </a>
          )}
        </div>

        <details className="text-sm text-slate-700">
          <summary className="cursor-pointer text-slate-500 hover:text-brand">
            Show full job description
          </summary>
          <p className="whitespace-pre-wrap mt-2 leading-relaxed">{job.description}</p>
        </details>
        <button onClick={deleteJob} className="text-xs text-slate-400 hover:text-rose-600">
          Delete job
        </button>
      </header>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-slate-900">AI Match</h2>
          <button
            onClick={runMatch}
            disabled={matching || !canRunMatch}
            className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2.5 disabled:opacity-40 hover:bg-brand-dark transition-colors"
          >
            {matching ? "Matching… (can take a minute)" : latestMatch ? "Re-run AI Match" : "Run AI Match"}
          </button>
        </div>
        <OllamaStatusBadge />

        {!canRunMatch && !matchError && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-3">
            Add or refresh this job&apos;s description before running AI Match.
          </div>
        )}

        {matchError && (
          <div className="rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-3">
            {matchError}
          </div>
        )}

        {!latestMatch && !matchError && (
          <p className="text-sm text-slate-500">
            No match run yet. Approve resume facts on the Profile page, then click Run AI Match.
          </p>
        )}

        {latestMatch && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-slate-200 p-6 flex items-start gap-6">
              <MatchScoreBadge score={latestMatch.score} eligibility={latestMatch.eligibility} />
              <div className="space-y-2">
                <p className="text-sm text-slate-700">
                  <span className="font-semibold">Eligibility reason: </span>
                  {latestMatch.eligibilityReason}
                </p>
                <p className="text-sm text-slate-700">
                  <span className="font-semibold">Why this score: </span>
                  {latestMatch.explanation}
                </p>
                <p className="text-xs text-slate-400">
                  Last run {new Date(latestMatch.createdAt).toLocaleString()}
                </p>
              </div>
            </div>

            <div className={`rounded-xl border p-4 ${RECOMMENDATION_STYLE[latestMatch.recommendation] ?? RECOMMENDATION_STYLE.Consider}`}>
              <span className="font-semibold">{latestMatch.recommendation}: </span>
              {latestMatch.recommendation === "Apply" && "This looks like a strong, eligible match worth applying to."}
              {latestMatch.recommendation === "Skip" && "An explicit eligibility requirement isn't met — applying isn't recommended."}
              {latestMatch.recommendation === "Consider" && "A borderline match — worth a closer look before deciding."}
            </div>

            {tailoring.length > 0 && (
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <h3 className="text-sm font-semibold text-slate-800 mb-2">Resume tailoring preview</h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-slate-700">
                  {tailoring.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <SkillBucket variant="supported" items={parseSkills(latestMatch.skillsSupported)} />
              <SkillBucket variant="confirm" items={parseSkills(latestMatch.skillsNeedConfirmation)} />
              <SkillBucket variant="learn" items={parseSkills(latestMatch.skillsToLearn)} />
              <SkillBucket variant="never" items={parseSkills(latestMatch.skillsNeverAdd)} />
            </div>
          </div>
        )}
      </section>

      {latestMatch && latestMatch.eligibility !== "Fail" && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-medium text-slate-900">Tailored documents</h2>
            <button
              onClick={generateDocuments}
              disabled={generatingDocs}
              className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2.5 disabled:opacity-40 hover:bg-brand-dark transition-colors"
            >
              {generatingDocs ? "Generating… (can take a minute)" : documents.length > 0 ? "Regenerate documents" : "Generate tailored documents"}
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Only pre-approved bullets and facts are used — nothing is written fresh per job.
            Compiled with Typst, then re-checked for merged words, reading order, and that dates/GPA
            match your locked facts exactly.
          </p>
          {docError && (
            <div className="rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-3">{docError}</div>
          )}
          {documents.length === 0 && !docError && (
            <p className="text-sm text-slate-500">No documents generated yet for this job.</p>
          )}
          {documents.length > 0 && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                {newestValidDocuments.map((document) => <GeneratedDocumentCard key={document.id} document={document} />)}
              </div>
              {previousValidDocuments.length > 0 && (
                <details className="rounded-xl border border-slate-200 bg-white p-4">
                  <summary className="cursor-pointer text-sm font-medium text-slate-700">Previous versions ({previousValidDocuments.length})</summary>
                  <div className="mt-3 grid grid-cols-2 gap-4">
                    {previousValidDocuments.map((document) => <GeneratedDocumentCard key={document.id} document={document} />)}
                  </div>
                </details>
              )}
              {archivedInvalidDocuments.length > 0 && (
                <details className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                  <summary className="cursor-pointer text-sm font-medium text-amber-800">Archived invalid documents ({archivedInvalidDocuments.length})</summary>
                  <p className="mt-2 text-xs text-amber-700">These documents are never selected or uploaded by the Application Agent.</p>
                  <div className="mt-3 grid grid-cols-2 gap-4">
                    {archivedInvalidDocuments.map((document) => <GeneratedDocumentCard key={document.id} document={document} />)}
                  </div>
                </details>
              )}
            </div>
          )}
        </section>
      )}

      {(applicationUrl || sourceListingUrl) && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-medium text-slate-900">Application</h2>
            {applicationUrl ? (
              <button
                onClick={applyToJob}
                className="rounded-lg bg-brand text-white text-sm font-medium px-4 py-2.5 hover:bg-brand-dark transition-colors"
              >
                Apply
              </button>
            ) : (
              <a
                href={sourceListingUrl ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Open source listing
              </a>
            )}
          </div>
          <p className="text-xs text-slate-500">
            {applicationUrl
              ? "Opens the official employer application page in a new tab. Use the independently installed Internship-Agent extension to autofill."
              : "The official employer application page has not been resolved yet."}
          </p>
          {runs.length === 0 && (
            <p className="text-sm text-slate-500">No application runs yet.</p>
          )}
          {runs.length > 0 && (
            <div className="space-y-3">
              {runs.map((r) => (
              <div key={r.id} className="bg-white rounded-xl border border-slate-200 p-4 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-800">
                    {r.atsType} · {r.mode === "auto_submit" ? "Auto-Submit" : "Legacy run — inactive"}
                  </span>
                    <span
                      className={`text-xs rounded-full border px-2 py-1 ${
                        r.status === "submitted"
                          ? "bg-emerald-100 text-emerald-700 border-emerald-300"
                          : r.status === "needs_user_action"
                            ? "bg-orange-100 text-orange-800 border-orange-300"
                            : r.status === "filled"
                              ? "bg-indigo-100 text-indigo-700 border-indigo-300"
                              : r.status === "failed"
                                ? "bg-rose-100 text-rose-700 border-rose-300"
                                : "bg-slate-100 text-slate-700 border-slate-300"
                      }`}
                    >
                      {displayRunState(r)}
                    </span>
                  </div>
                  {r.documentStrategy && (
                    <p className="text-xs text-slate-500">
                      Resume: <span className="font-medium">{r.documentStrategy}</span>
                      {r.documentStrategyReason ? ` — ${r.documentStrategyReason}` : ""}
                    </p>
                  )}
                  {r.needsUserActionReason && (
                    <p className="text-xs text-orange-700">
                      {STOP_REASON_LABELS[r.needsUserActionReason] ?? r.needsUserActionReason}
                    </p>
                  )}
                  {r.stoppedFieldLabel && (
                    <p className="text-xs text-slate-500">
                      Question: <span className="font-medium">{r.stoppedFieldLabel}</span>
                    </p>
                  )}
                  {r.status === "needs_user_action" && (
                    <div className="text-xs text-slate-600 space-y-1">
                      <p>Field type: <span className="font-medium">{r.stoppedFieldType || "unknown"}</span></p>
                      <p>Application step: <span className="font-medium">{r.stoppedFieldStep ?? r.currentStep ?? "unknown"}</span></p>
                      <p>Available options: {parseStrings(r.stoppedFieldOptions).length > 0 ? parseStrings(r.stoppedFieldOptions).join(", ") : "None detected"}</p>
                      {r.stoppedFieldContext && (() => {
                        const context = JSON.parse(r.stoppedFieldContext) as { required?: boolean; ariaLabel?: string; placeholder?: string; nearbyText?: string; pageUrl?: string };
                        return <div className="space-y-0.5">
                          <p>Required: <span className="font-medium">{context.required === undefined ? "Unknown (legacy run)" : context.required ? "Yes" : "No"}</span></p>
                          {context.ariaLabel && <p>ARIA label: {context.ariaLabel}</p>}
                          {context.placeholder && <p>Placeholder: {context.placeholder}</p>}
                          {context.nearbyText && <p>Nearby text: {context.nearbyText}</p>}
                          {context.pageUrl && <p>Page: <a className="text-brand hover:underline" href={context.pageUrl} target="_blank" rel="noopener noreferrer">{context.pageUrl}</a></p>}
                        </div>;
                      })()}
                      {r.screenshotPath && <a className="text-brand hover:underline" href={`/api/applications/${r.id}/screenshot`} target="_blank" rel="noopener noreferrer">Open screenshot ↗</a>}
                    </div>
                  )}
                  {r.stoppedFieldLabel && r.needsUserActionReason && REUSABLE_STOP_REASONS.has(r.needsUserActionReason) && (
                    <div className="space-y-2 pt-1">
                      <div className="flex gap-2">
                        <input value={answerDrafts[r.id] ?? ""} onChange={(e) => setAnswerDrafts({ ...answerDrafts, [r.id]: e.target.value })} placeholder="Type the answer…" className="input-sm flex-1" />
                        <button onClick={() => saveAnswerAndRetry(r.id)} disabled={savingAnswerId === r.id} className="text-xs rounded-lg bg-brand text-white px-3 py-1.5 disabled:opacity-40 hover:bg-brand-dark transition-colors">
                          {savingAnswerId === r.id ? "Saving…" : "Save & retry"}
                        </button>
                      </div>
                      <label className="flex items-center gap-2 text-xs text-slate-600">
                        <input type="checkbox" checked={answerReuse[r.id] === true} onChange={(e) => setAnswerReuse({ ...answerReuse, [r.id]: e.target.checked })} />
                        Reuse this answer for the same normalized question
                      </label>
                    </div>
                  )}
                  {r.status === "needs_user_action" && (!r.stoppedFieldLabel || !r.needsUserActionReason || !REUSABLE_STOP_REASONS.has(r.needsUserActionReason)) && (
                    <button onClick={() => resumePausedRun(r.id)} disabled={savingAnswerId === r.id} className="text-xs rounded-lg bg-brand text-white px-3 py-1.5 disabled:opacity-40 hover:bg-brand-dark transition-colors">
                      {savingAnswerId === r.id ? "Queuing…" : "Resume same run"}
                    </button>
                  )}
                  {r.status === "failed" && (
                    <button disabled={true} className="text-xs rounded-lg bg-slate-300 text-white px-3 py-1.5 opacity-50 cursor-not-allowed">
                      Retry failed run
                    </button>
                  )}
                  {r.confirmationNumber && (
                    <p className="text-xs text-slate-600">Confirmation: {r.confirmationNumber}</p>
                  )}
                  {r.confirmationUrl && (
                    <a href={r.confirmationUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-brand hover:underline">
                      Confirmation page ↗
                    </a>
                  )}
                  {r.errorLog && <div className="text-xs text-rose-700">
                    <p>{friendlyRunError(r.errorLog)}</p>
                    <details className="mt-1 rounded border border-rose-200 p-2 text-slate-700">
                      <summary className="cursor-pointer font-medium">Show details</summary>
                      <pre className="mt-2 overflow-auto whitespace-pre-wrap">{r.errorLog}</pre>
                    </details>
                  </div>}
                  <p className="text-xs text-slate-400">
                    {new Date(r.createdAt).toLocaleString()}
                    {r.finishedAt && ` – ${new Date(r.finishedAt).toLocaleString()}`}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="font-medium text-slate-900">Activity timeline</h2>
        <p className="text-xs text-slate-500">
          A permanent, append-only record of every automated decision made about this job — never
          edited or deleted.
        </p>
        {auditLog.length === 0 ? (
          <p className="text-sm text-slate-500">No activity recorded yet.</p>
        ) : (
          <ol className="space-y-2 border-l-2 border-slate-200 pl-4">
            {auditLog.map((entry) => (
              <li key={entry.id} className="text-sm">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                    {ACTOR_LABELS[entry.actor] ?? entry.actor}
                  </span>
                  <span className="text-xs text-slate-400">{new Date(entry.createdAt).toLocaleString()}</span>
                </div>
                <p className="text-slate-700">{entry.detail}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
