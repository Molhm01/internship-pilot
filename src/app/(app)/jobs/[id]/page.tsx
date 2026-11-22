"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import StatusSelector from "@/components/StatusSelector";
import MatchScoreBadge from "@/components/MatchScoreBadge";
import SkillBucket, { SkillItem } from "@/components/SkillBucket";
import OllamaStatusBadge from "@/components/OllamaStatusBadge";
import VerificationBadge from "@/components/VerificationBadge";
import {
  selectStoredApplicationLinks,
} from "@/lib/jobs/applicationUrl";
import { postedLabel } from "@/lib/jobs/postedAge";
import {
  hasUsableJobDescription,
  manualMatchToImmediateDisplay,
  runManualMatchAndRefresh,
} from "@/lib/matchWorkflow";
import {
  fetchDocumentPdf,
  fetchJobDocuments,
  runTailoredDocumentGeneration,

  type StoredGeneratedDocument,
} from "@/lib/documents/client";

import { useRuntimeCapabilities } from "@/lib/runtime/capabilitiesClient";
import LocalAiOfflineNotice from "@/components/LocalAiOfflineNotice";
import { ArtifactPreviewModal } from "@/components/ui/ArtifactPreviewModal";
import { getGmailAccessToken } from "@/lib/gmail/clientAuth";
import { toast } from "@/components/ui/Toast";

type MatchResultRaw = {
  id: string;
  eligibility: string;
  eligibilityReason: string;
  score: number;
  explanation: string;
  recommendation: string | null;
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
  sourcePostedAt?: string | null;
  sourcePostedText?: string | null;
  sourceDateConfidence?: string | null;
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

type GeneratedDoc = StoredGeneratedDocument;

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
  answers?: string | null;
  stageHistory?: string | null;
  errorLog: string | null;
  createdAt: string;
  finishedAt: string | null;
};

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

function parseSkills(json: string): SkillItem[] {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function parseStageHistory(json: string | null | undefined): Array<{ stage: string; at: string; detail?: string }> {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseRunAnswersMap(json: string | null | undefined): Array<[string, string]> {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string");
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

function parseKeywordClassification(json: string | null): {
  supported: string[];
  confirmationRequired: string[];
  developmentGap: string[];
  unsupported: string[];
} {
  try {
    const parsed = JSON.parse(json ?? "{}") as Record<string, unknown>;
    const strings = (value: unknown) => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
    return {
      supported: strings(parsed.supported),
      confirmationRequired: strings(parsed.confirmationRequired),
      developmentGap: strings(parsed.developmentGap),
      unsupported: strings(parsed.unsupported),
    };
  } catch {
    return { supported: [], confirmationRequired: [], developmentGap: [], unsupported: [] };
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
  if (run.status === "needs_user_action") return "AUTONOMOUS RETRY";
  if (run.status === "filled") return "NOT SUBMITTED — PORTAL PENDING";
  if (run.status === "submitted" || run.status === "completed") return "SUBMITTED ✓";
  if (run.status === "failed") return "FAILED";
  if (run.status === "running") {
    return ["STARTING_BROWSER", "NAVIGATING", "FILLING"].includes(run.currentStep ?? "")
      ? (run.currentStep ?? "FILLING").replace(/_/g, " ")
      : "FILLING";
  }
  return run.status.replace(/_/g, " ").toUpperCase();
}

/**
 * One document's delivery state, kept deliberately separate from whether it was
 * generated. The extension can only attach what the agent is holding, so
 * "Generated" and "Sent to extension" are different claims and the second one is
 * only made when the agent acknowledged the bytes.
 */
function GeneratedDocumentCard({ document, onOpen }: { document: GeneratedDoc; onOpen: (document: GeneratedDoc) => void }) {
  const issues = parseStrings(document.qaIssues);
  const keywords = parseKeywordClassification(document.keywordClassification);
  return (
    <div className="bg-surface rounded-lg border border-hairline p-4 space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-medium text-primary capitalize">
          {document.type === "coverLetter" ? "Cover Letter" : "Resume"} (V{document.version})
        </span>
        <span className={`text-xs rounded-sm border px-1.5 py-0.5 font-mono text-micro uppercase tracking-wide ${
          document.qaStatus === "pass" && document.identityVerified
            ? "bg-verified-quiet text-verified border-verified-line"
            : "bg-critical-quiet text-critical border-critical-line"
        }`}>
          {document.qaStatus === "INVALID_TEST_DATA" ? "INVALID TEST DATA" : `QA ${document.qaStatus}`}
        </span>
      </div>
      <button
        type="button"
        onClick={() => onOpen(document)}
        className="text-sm text-accent-text hover:underline"
      >
        Open PDF ↗
      </button>
      <p className="text-xs text-tertiary">
        Generated {new Date(document.createdAt).toLocaleString()}
      </p>
      {issues.length > 0 && (
        <ul className="text-xs text-caution list-disc list-inside">
          {issues.map((issue, index) => <li key={index}>{issue}</li>)}
        </ul>
      )}
      {document.tailoringStatus && (
        <p className="text-xs font-medium text-secondary">{document.tailoringStatus}</p>
      )}
      {(keywords.supported.length > 0 || keywords.confirmationRequired.length > 0 || keywords.developmentGap.length > 0 || keywords.unsupported.length > 0) && (
        <div className="text-xs text-secondary space-y-1">
          <p><strong>Keywords used:</strong> {keywords.supported.length ? keywords.supported.join(", ") : "None"}</p>
          <p><strong>Keywords intentionally excluded:</strong> {[...keywords.confirmationRequired, ...keywords.developmentGap, ...keywords.unsupported].join(", ") || "None"}</p>
        </div>
      )}
      {document.tailoringAudit && (() => {
        try {
          const audit = JSON.parse(document.tailoringAudit) as {
            originalAtsMatchScore: number;
            tailoredAtsMatchScore: number;
            scoreMethod?: string;
            keywordsAdded: string[];
            bulletsChanged: Array<{ original: string; tailored: string; evidence: Array<{ factId: string; content: string }>; jobRequirementAddressed?: string }>;
            bulletsReordered?: Array<{ entry: string; before: string[]; after: string[] }>;
            skillsReordered?: Array<{ group: string; before: string[]; after: string[] }>;
            supportedKeywords: Array<{ keyword: string; evidence: Array<{ factId: string; content: string }> }>;
            unsupportedRequirementsNotAdded: string[];
            formattingPreservation?: { status: "pass" | "fail"; method: string; issues: string[] };
          };
          return (
            <details className="text-xs rounded border border-hairline p-2">
              <summary className="cursor-pointer font-medium">Tailoring Audit</summary>
              <div className="mt-2 space-y-2">
                <p>Original ATS match: {audit.originalAtsMatchScore} · Tailored ATS match: {audit.tailoredAtsMatchScore}</p>
                {audit.scoreMethod && <p><strong>Score explanation:</strong> {audit.scoreMethod}</p>}
                <p><strong>Keywords added:</strong> {audit.keywordsAdded.length ? audit.keywordsAdded.join(", ") : "None"}</p>
                <div><strong>Exact bullets changed:</strong>{audit.bulletsChanged.length ? <ul className="list-disc pl-4">{audit.bulletsChanged.map((change, index) => <li key={index}><span className="line-through">{change.original}</span><br />→ {change.tailored}{change.jobRequirementAddressed && <><br /><span className="text-tertiary">Job requirement: {change.jobRequirementAddressed}</span></>}<br /><span className="text-tertiary">Evidence: {change.evidence.map((item) => `${item.content} (${item.factId})`).join("; ")}</span></li>)}</ul> : " None"}</div>
                <div><strong>Bullet order changes:</strong>{audit.bulletsReordered?.length ? <ul className="list-disc pl-4">{audit.bulletsReordered.map((change) => <li key={change.entry}>{change.entry}: {change.after.map((bullet, index) => `${index + 1}. ${bullet}`).join(" ")}</li>)}</ul> : " None"}</div>
                <div><strong>Skill order changes:</strong>{audit.skillsReordered?.length ? <ul className="list-disc pl-4">{audit.skillsReordered.map((change) => <li key={change.group}>{change.group}: {change.after.join(", ")}</li>)}</ul> : " None"}</div>
                <div><strong>Supported keywords:</strong><ul className="list-disc pl-4">{audit.supportedKeywords.map((item) => <li key={item.keyword}>{item.keyword}: {item.evidence.map((fact) => fact.content).join("; ")}</li>)}</ul></div>
                <div><strong>Intentionally not added:</strong><ul className="list-disc pl-4">{audit.unsupportedRequirementsNotAdded.map((item) => <li key={item}>{item}</li>)}</ul></div>
                <div><strong>Formatting preservation:</strong> {audit.formattingPreservation ? audit.formattingPreservation.status.toUpperCase() : "Not recorded"}</div>
                {audit.formattingPreservation && <p className="text-tertiary">{audit.formattingPreservation.method}</p>}
                {audit.formattingPreservation?.issues.length ? <ul className="list-disc pl-4 text-critical">{audit.formattingPreservation.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : null}
              </div>
            </details>
          );
        } catch {
          return <p className="text-xs text-caution">Tailoring audit metadata is unreadable.</p>;
        }
      })()}
    </div>
  );
}

const RECOMMENDATION_STYLE: Record<string, string> = {
  Apply: "bg-verified-quiet border-verified-line text-verified",
  Skip: "bg-critical-quiet border-critical-line text-critical",
  Consider: "bg-caution-quiet border-caution-line text-caution",
};

function logJobPageTiming(operation: string, jobId: string, startedAt: number) {
  if (process.env.NODE_ENV !== "development") return;
  console.info(JSON.stringify({
    event: "job-page-timing",
    operation,
    jobId,
    durationMs: Math.round(performance.now() - startedAt),
  }));
}

export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [matchingJobs, setMatchingJobs] = useState<Record<string, boolean>>({});
  const activeMatchRequests = useRef(new Map<string, AbortController>());
  const [matchErrors, setMatchErrors] = useState<Record<string, string>>({});
  const [verifying, setVerifying] = useState(false);
  const [documents, setDocuments] = useState<GeneratedDoc[]>([]);
  const [generatingDocumentJobs, setGeneratingDocumentJobs] = useState<Record<string, boolean>>({});
  const activeDocumentRequests = useRef(new Map<string, AbortController>());
  const [docError, setDocError] = useState<string | null>(null);
    const [runs, setRuns] = useState<ApplicationRun[]>([]);
  const [savingAnswerId, setSavingAnswerId] = useState<string | null>(null);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  // Handing the tailored documents to the extension. `null` means the probe has
  // not run yet, which is distinct from "the extension is not there".
    // Typst compiles these PDFs with a native binary on whatever machine is
  // serving this page, so on a hosted install the button would post a request
  // that cannot succeed.
  const { serverSideDocumentGeneration: canGenerateDocuments } = useRuntimeCapabilities();
    const [handoffError, setHandoffError] = useState<string | null>(null);
  const [autoApplyState, setAutoApplyState] = useState<"idle" | "applying" | "done">("idle");
  const [autoApplyMessage, setAutoApplyMessage] = useState<string | null>(null);
  const [autoApplyOutcomeStatus, setAutoApplyOutcomeStatus] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [previewArtifact, setPreviewArtifact] = useState<{
    open: boolean;
    url: string | null;
    title: string;
    loadBlob?: (() => Promise<Blob>) | null;
    filename?: string;
    kind?: "image" | "pdf";
  }>({ open: false, url: null, title: "" });
  const initialLoadJobId = useRef<string | null>(null);
  const matching = matchingJobs[id] === true;
  const matchError = matchErrors[id] ?? null;
  const generatingDocs = generatingDocumentJobs[id] === true;
  const evidence = job?.evidence ?? null;
  const formattedEvidence = useMemo(() => {
    if (!evidence) return null;
    try {
      return JSON.stringify(JSON.parse(evidence), null, 2);
    } catch {
      return evidence;
    }
  }, [evidence]);

  function setMatchError(message: string | null) {
    setMatchErrors((current) => {
      if (message) return { ...current, [id]: message };
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  const load = useCallback(async () => {
    const startedAt = performance.now();
    try {
      const res = await fetch(`/api/jobs/${id}`);
      if (res.status === 404) {
        setJob(null);
        setLoading(false);
        return;
      }
      const data = await res.json();
      setJob(data.job);
      setLoading(false);
    } finally {
      logJobPageTiming("job-fetch", id, startedAt);
    }
  }, [id]);

  const loadDocuments = useCallback(async (showError = true) => {
    const startedAt = performance.now();
    try {
      setDocuments(await fetchJobDocuments(id));
      if (showError) setDocError(null);
    } catch (error) {
      if (showError) {
        setDocError(error instanceof Error ? error.message : "Could not load saved tailored documents.");
      }
    } finally {
      logJobPageTiming("tailored-document-metadata-fetch", id, startedAt);
    }
  }, [id]);

  const loadRuns = useCallback(async () => {
    const startedAt = performance.now();
    try {
      const res = await fetch(`/api/jobs/${id}/applications`);
      if (res.ok) {
        const data = await res.json();
        const nextRuns = data.runs ?? [];
        setRuns(nextRuns);
        return nextRuns as ApplicationRun[];
      }
      return [];
    } finally {
      logJobPageTiming("application-run-fetch", id, startedAt);
    }
  }, [id]);

  const loadAuditLog = useCallback(async () => {
    const startedAt = performance.now();
    try {
      const res = await fetch(`/api/jobs/${id}/audit-log`);
      if (res.ok) {
        const data = await res.json();
        setAuditLog(data.entries ?? []);
      }
    } finally {
      logJobPageTiming("activity-timeline-fetch", id, startedAt);
    }
  }, [id]);

  useEffect(() => {
    if (initialLoadJobId.current === id) return;
    initialLoadJobId.current = id;
    const startedAt = performance.now();
    void Promise.all([load(), loadDocuments(), loadRuns(), loadAuditLog()])
      .catch(() => setLoading(false))
      .finally(() => logJobPageTiming("initial-job-page-load", id, startedAt));
  }, [id, load, loadDocuments, loadRuns, loadAuditLog]);

  // The extension may be installed, disabled, or mid-reload. Probing once per
  // job view keeps the button honest without polling.
    useEffect(() => () => {
    activeDocumentRequests.current.get(id)?.abort();
    activeDocumentRequests.current.delete(id);
  }, [id]);

  useEffect(() => () => {
    activeMatchRequests.current.get(id)?.abort();
    activeMatchRequests.current.delete(id);
  }, [id]);

  async function autonomousApplyNow() {
    if (!job) return;
    setAutoApplyState("applying");
    setAutoApplyMessage(null);
    setAutoApplyOutcomeStatus(null);
    setHandoffError(null);
    const toastId = toast.loading(`Auto-applying to ${job.company}…`, { description: job.title });
    try {
      const gmailToken = getGmailAccessToken();
      const response = await fetch(`/api/jobs/${job.id}/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(gmailToken ? { Authorization: `Bearer ${gmailToken}` } : {}),
        },
        body: JSON.stringify({ mode: "auto_submit" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Autonomous application failed.");
      }
      setAutoApplyState("done");
      const st = typeof data.status === "string" ? data.status : null;
      setAutoApplyOutcomeStatus(st);
      const statusLabel = st ? st.replace(/_/g, " ") : "completed";
      const suffix = data.confirmationNumber
        ? ` (Confirmation: ${String(data.confirmationNumber)})`
        : data.stoppedFieldLabel
          ? ` — waiting on "${String(data.stoppedFieldLabel)}"`
          : "";
      const message =
        typeof data.detail === "string" && data.detail.trim()
          ? `${data.detail}${suffix}`
          : `Autonomous run finished (${statusLabel})${suffix}.`;
      setAutoApplyMessage(message);
      if (st === "submitted") {
        toast.success(`Application submitted to ${job.company}`, { id: toastId, description: message });
      } else if (st === "failed") {
        toast.error(`Auto-Apply stopped on ${job.company}`, { id: toastId, description: message });
      } else {
        toast.info(`Not submitted yet — packet prepared for ${job.company}`, { id: toastId, description: message });
      }
      await Promise.all([load(), loadDocuments(false), loadRuns(), loadAuditLog()]);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Autonomous application failed.";
      setAutoApplyState("idle");
      setHandoffError(errMsg);
      toast.error(`Auto-Apply failed for ${job.company}`, { id: toastId, description: errMsg });
    }
  }

  async function retryFailedRun(runId: string) {
    setSavingAnswerId(runId);
    setHandoffError(null);
    const toastId = toast.loading("Retrying autonomous application…");
    try {
      const response = await fetch(`/api/applications/${runId}/retry`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errMsg = typeof data.error === "string" ? data.error : "Retry failed.";
        setHandoffError(errMsg);
        toast.error("Retry failed", { id: toastId, description: errMsg });
        return;
      }
      const msg = typeof data.detail === "string" ? data.detail : "Application retry completed.";
      if (data.status === "submitted") {
        toast.success("Application submitted", { id: toastId, description: msg });
      } else if (data.status === "failed") {
        toast.error("Retry paused", { id: toastId, description: msg });
      } else {
        toast.info("Retry updated packet", { id: toastId, description: msg });
      }
      await Promise.all([loadRuns(), load(), loadAuditLog()]);
    } finally {
      setSavingAnswerId(null);
    }
  }

  const {
    newestValidDocuments,
    previousValidDocuments,
    archivedInvalidDocuments,
  } = useMemo(() => {
    const validDocuments = documents.filter((document) =>
      document.qaStatus === "pass" && document.identityVerified,
    );
    const newest = ["resume", "coverLetter"]
      .map((type) => validDocuments.find((document) => document.type === type))
      .filter((document): document is GeneratedDoc => Boolean(document));
    const newestIds = new Set(newest.map((document) => document.id));
    return {
      newestValidDocuments: newest,
      previousValidDocuments: validDocuments.filter((document) => !newestIds.has(document.id)),
      archivedInvalidDocuments: documents.filter((document) =>
        !validDocuments.some((valid) => valid.id === document.id),
      ),
    };
  }, [documents]);

  async function generateDocuments() {
    if (activeDocumentRequests.current.has(id)) return;
    const controller = new AbortController();
    activeDocumentRequests.current.set(id, controller);
    setDocError(null);
        try {
      await runTailoredDocumentGeneration({
        jobId: id,
        signal: controller.signal,
        onLoadingChange: (jobId, active) => {
          setGeneratingDocumentJobs((current) => {
            if (active) return { ...current, [jobId]: true };
            const next = { ...current };
            delete next[jobId];
            return next;
          });
        },
        refreshDocuments: async () => {
          await Promise.all([loadDocuments(), loadAuditLog()]);
        },
      });
          } catch (error) {
      setDocError(error instanceof Error ? error.message : "Could not generate documents.");
      await loadDocuments(false);
    } finally {
      if (activeDocumentRequests.current.get(id) === controller) {
        activeDocumentRequests.current.delete(id);
      }
    }
  }

  function openDocument(document: GeneratedDoc) {
    setDocError(null);
    const docLabel = document.type === "coverLetter" ? "Cover Letter" : "Resume";
    setPreviewArtifact({
      open: true,
      url: `/api/documents/${document.id}/download`,
      loadBlob: () => fetchDocumentPdf(document.id),
      title: `${job?.company ?? ""} · ${docLabel} (V${document.version})`,
      filename: `${document.type}-v${document.version}.pdf`,
      kind: "pdf",
    });
  }

  async function runMatch() {
    if (activeMatchRequests.current.has(id)) return;
    const controller = new AbortController();
    activeMatchRequests.current.set(id, controller);
    setMatchError(null);
    try {
      await runManualMatchAndRefresh({
        jobId: id,
        signal: controller.signal,
        onLoadingChange: (jobId, active) => {
          setMatchingJobs((current) => {
            if (active) return { ...current, [jobId]: true };
            const next = { ...current };
            delete next[jobId];
            return next;
          });
        },
        onResult: (jobId, result) => {
          const immediate = manualMatchToImmediateDisplay(result);
          setJob((current) => current?.id === jobId
            ? { ...current, matchResults: [immediate, ...current.matchResults] }
            : current);
        },
        refreshMatch: async () => {
          await Promise.all([load(), loadAuditLog()]);
        },
        onRefreshError: (jobId) => {
          if (process.env.NODE_ENV === "development") {
            console.warn(JSON.stringify({
              event: "job-page-refresh-failed",
              jobId,
              operation: "post-match-refresh",
            }));
          }
        },
      });
    } catch (error) {
      setMatchError(error instanceof Error ? error.message : "Could not run match.");
    } finally {
      setMatchingJobs((current) => {
        if (!current[id]) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
      if (activeMatchRequests.current.get(id) === controller) {
        activeMatchRequests.current.delete(id);
      }
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
    await fetch(`/api/jobs/${id}`, { method: "DELETE" });
    router.push("/jobs");
  }

  if (loading) {
    return <div className="max-w-4xl mx-auto px-8 py-10 text-sm text-tertiary">Loading…</div>;
  }

  if (!job) {
    return (
      <div className="max-w-4xl mx-auto px-8 py-10">
        <p className="text-sm text-tertiary">Job not found.</p>
        <Link href="/jobs" className="text-accent-text text-sm hover:underline">
          Back to jobs
        </Link>
      </div>
    );
  }

  const latestMatch = job.matchResults[0];
  const displayedEligibility = latestMatch?.eligibility === "Unknown"
    ? "BORDERLINE"
    : latestMatch?.eligibility.toUpperCase();
  const canRunMatch = hasUsableJobDescription(job) || job.matchResults.length > 0 || Boolean(job.title && job.company);
  const tailoring = parseStrings(latestMatch?.tailoringPreview ?? null);
  const { applicationUrl, sourceListingUrl } = selectStoredApplicationLinks(job);
  // The button is enabled only when there is somewhere to apply, a tailored
  // résumé exists, and the extension is actually listening. Each "no" carries
  // the sentence the UI shows instead of a bare disabled control.
  
  return (
    <div className="max-w-4xl mx-auto px-8 py-10 space-y-8">
      <Link href="/jobs" className="text-sm text-tertiary hover:text-accent-text">
        ← Back to jobs
      </Link>

      <header className="bg-surface rounded-lg border border-hairline p-6 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-title font-semibold tracking-tight text-primary">{job.title}</h1>
            <p className="text-secondary">{job.company}</p>
          </div>
          <StatusSelector value={job.status} onChange={changeStatus} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-tertiary">
          {job.location && <span>📍 {job.location}</span>}
          {job.workplaceType && <span>{job.workplaceType}</span>}
          {job.internshipTerm && <span>🗓 {job.internshipTerm}</span>}
          {job.duration && <span>⏱ {job.duration}</span>}
          {job.compensation && <span>💵 {job.compensation}</span>}
          {(() => {
            const posted = postedLabel(job);
            return (
              <span title={posted.title} className={posted.unknown ? "italic text-faint" : undefined}>
                {posted.text}
              </span>
            );
          })()}
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <VerificationBadge status={job.verificationStatus} />
          {job.source && (
            <span className="text-xs text-faint">
              Discovered via {job.source === "intern-list" ? "Intern List" : job.source}
            </span>
          )}
          <button
            onClick={reverify}
            disabled={verifying}
            className="text-xs text-accent-text hover:underline disabled:opacity-40"
          >
            {verifying ? "Re-checking…" : "Re-verify now"}
          </button>
        </div>
        {job.verificationReason && (
          <p className="text-xs text-tertiary">{job.verificationReason}</p>
        )}
        {job.lastVerifiedAt && (
          <p className="text-xs text-faint">
            Last verified {new Date(job.lastVerifiedAt).toLocaleString()}. This reflects the most
            recent check only — not a permanent or guaranteed status.
          </p>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-faint">
          {job.officialEmployerDomain && <span>Official domain: {job.officialEmployerDomain}</span>}
          {job.requisitionId && <span>Requisition ID: {job.requisitionId}</span>}
          {job.verificationMethod && <span>Method: {job.verificationMethod}</span>}
        </div>
        {formattedEvidence && (
          <details className="text-xs text-tertiary">
            <summary className="cursor-pointer hover:text-accent-text">Show verification evidence</summary>
            <pre className="mt-2 whitespace-pre-wrap bg-sunken rounded-lg p-3 text-[11px]">
              {formattedEvidence}
            </pre>
          </details>
        )}

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs pt-1">
          {applicationUrl && (
            <a href={applicationUrl} target="_blank" rel="noopener noreferrer" className="text-accent-text font-medium hover:underline">
              Official application ↗
            </a>
          )}
          {!applicationUrl && sourceListingUrl && (
            <a href={sourceListingUrl} target="_blank" rel="noopener noreferrer" className="text-faint hover:underline">
              Open source listing ↗
            </a>
          )}
        </div>

        <details className="text-sm text-secondary">
          <summary className="cursor-pointer text-tertiary hover:text-accent-text">
            Show full job description
          </summary>
          <p className="whitespace-pre-wrap mt-2 leading-relaxed">{job.description}</p>
        </details>
        {confirmingDelete ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-critical">Delete this job and its match history?</span>
            <button onClick={() => void deleteJob()} className="font-medium text-critical hover:underline">
              Confirm delete
            </button>
            <button onClick={() => setConfirmingDelete(false)} className="text-faint hover:underline">
              Cancel
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmingDelete(true)} className="text-xs text-faint hover:text-rose-600">
            Delete job
          </button>
        )}
      </header>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-primary">AI Match</h2>
          <button
            onClick={runMatch}
            disabled={matching || !canRunMatch}
            className="rounded-lg bg-accent text-inverse text-sm font-medium px-4 py-2.5 disabled:opacity-40 hover:bg-accent-hover transition-colors"
          >
            {matching ? "Matching…" : latestMatch ? "Re-run AI Match" : "Run AI Match"}
          </button>
        </div>
        <OllamaStatusBadge />

        {!canRunMatch && !matchError && (
          <div className="rounded-lg bg-caution-quiet border border-caution-line text-caution text-sm px-4 py-3">
            Add or refresh this job&apos;s description before running AI Match.
          </div>
        )}

        {matchError && (
          <div className="rounded-lg bg-critical-quiet border border-critical-line text-critical text-sm px-4 py-3">
            {matchError}
          </div>
        )}

        {!latestMatch && !matchError && (
          <p className="text-sm text-tertiary">
            Click Run AI Match or upload a resume on the Resume page to score this role.
          </p>
        )}

        {latestMatch && (
          <div className="space-y-4">
            <div className="bg-surface rounded-lg border border-hairline p-6 flex items-start gap-6">
              <MatchScoreBadge score={latestMatch.score} eligibility={displayedEligibility ?? latestMatch.eligibility} />
              <div className="space-y-2">
                <p className="text-sm text-secondary">
                  <span className="font-semibold">Score: </span>
                  {latestMatch.score}/100
                </p>
                <p className="text-sm text-secondary">
                  <span className="font-semibold">Eligibility reason: </span>
                  {latestMatch.eligibilityReason}
                </p>
                <p className="text-sm text-secondary">
                  <span className="font-semibold">Why this score: </span>
                  {latestMatch.explanation}
                </p>
                <p className="text-xs text-faint">
                  Last run {new Date(latestMatch.createdAt).toLocaleString()}
                </p>
              </div>
            </div>

            {latestMatch.recommendation && (
              <div className={`rounded-lg border p-4 ${RECOMMENDATION_STYLE[latestMatch.recommendation] ?? RECOMMENDATION_STYLE.Consider}`}>
                <span className="font-semibold">{latestMatch.recommendation}: </span>
                {latestMatch.recommendation === "Apply" && "This looks like a strong, eligible match worth applying to."}
                {latestMatch.recommendation === "Skip" && "An explicit eligibility requirement isn't met — applying isn't recommended."}
                {latestMatch.recommendation === "Consider" && "A borderline match — worth a closer look before deciding."}
              </div>
            )}

            {tailoring.length > 0 && (
              <div className="rounded-lg border border-hairline bg-surface p-4">
                <h3 className="text-sm font-semibold text-primary mb-2">Resume tailoring preview</h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-secondary">
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
            <h2 className="font-medium text-primary">Tailored documents</h2>
            <div className="flex items-center gap-2">

              <button
                onClick={generateDocuments}
                disabled={generatingDocs || !canGenerateDocuments}
                title={canGenerateDocuments ? undefined : "Tailored documents are compiled on your own computer."}
                className="rounded-lg bg-accent text-inverse text-sm font-medium px-4 py-2.5 disabled:opacity-40 hover:bg-accent-hover transition-colors"
              >
                {generatingDocs ? "Generating… (can take a minute)" : documents.length > 0 ? "Regenerate documents" : "Generate tailored documents"}
              </button>
            </div>
          </div>
          {/* Shown only on a hosted install, where compilation and delivery
              both happen on the user's machine rather than on this server. */}
          <LocalAiOfflineNotice feature="Tailored document generation" />
          <p className="text-xs text-tertiary">
            Automatically tailored from your uploaded resume and automatically validated before submission.
          </p>
          {docError && (
            <div className="rounded-lg bg-critical-quiet border border-critical-line text-critical text-sm px-4 py-3">{docError}</div>
          )}
          {documents.length === 0 && !docError && (
            <p className="text-sm text-tertiary">No documents generated yet for this job.</p>
          )}
          {documents.length > 0 && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                {newestValidDocuments.map((document) => <GeneratedDocumentCard key={document.id} document={document} onOpen={openDocument} />)}
              </div>
              {previousValidDocuments.length > 0 && (
                <details className="rounded-lg border border-hairline bg-surface p-4">
                  <summary className="cursor-pointer text-sm font-medium text-secondary">Previous versions ({previousValidDocuments.length})</summary>
                  <div className="mt-3 grid grid-cols-2 gap-4">
                    {previousValidDocuments.map((document) => <GeneratedDocumentCard key={document.id} document={document} onOpen={openDocument} />)}
                  </div>
                </details>
              )}
              {archivedInvalidDocuments.length > 0 && (
                <details className="rounded-lg border border-caution-line bg-caution-quiet p-4">
                  <summary className="cursor-pointer text-sm font-medium text-caution">Archived invalid documents ({archivedInvalidDocuments.length})</summary>
                  <p className="mt-2 text-xs text-caution">These documents are never selected or uploaded by the Application Agent.</p>
                  <div className="mt-3 grid grid-cols-2 gap-4">
                    {archivedInvalidDocuments.map((document) => <GeneratedDocumentCard key={document.id} document={document} onOpen={openDocument} />)}
                  </div>
                </details>
              )}
            </div>
          )}
        </section>
      )}

      {(applicationUrl || sourceListingUrl) && (
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="font-medium text-primary">Application</h2>
            {applicationUrl ? (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => void autonomousApplyNow()}
                  disabled={autoApplyState === "applying"}
                  className="inline-flex h-9 shrink-0 whitespace-nowrap items-center gap-2 rounded-md border border-accent bg-accent px-4 text-small font-medium text-inverse hover:bg-accent-hover transition-colors disabled:opacity-40"
                >
                  {autoApplyState === "applying"
                    ? "Applying autonomously…"
                    : "Auto-Apply Now"}
                </button>
                <a
                  href={applicationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-9 shrink-0 whitespace-nowrap items-center gap-2 rounded-md border border-line bg-surface px-3.5 text-small font-medium text-primary shadow-raised hover:bg-n-150 transition-colors"
                >
                  Open official page ↗
                </a>
              </div>
            ) : (
              <a
                href={sourceListingUrl ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-medium text-secondary hover:bg-sunken"
              >
                Open source listing
              </a>
            )}
          </div>
          <p className="text-xs text-tertiary">
            {!applicationUrl
              ? "The official employer application page has not been resolved yet."
              : "Auto-Apply Now automatically compiles your tailored PDFs, resolves portal fields from your profile, and submits the application end-to-end."}
          </p>
          {autoApplyMessage && (
            <p
              className={`rounded-lg border px-3 py-2 text-xs ${
                autoApplyOutcomeStatus === "submitted"
                  ? "border-verified-line bg-verified-quiet text-verified"
                  : autoApplyOutcomeStatus === "needs_user_action"
                    ? "border-caution-line bg-caution-quiet text-caution"
                    : autoApplyOutcomeStatus === "failed"
                      ? "border-critical-line bg-critical-quiet text-critical"
                      : "border-info-line bg-info-quiet text-info"
              }`}
              role="status"
            >
              {autoApplyMessage}
            </p>
          )}
          {handoffError && (
            <p className="rounded-lg border border-critical-line bg-critical-quiet px-3 py-2 text-xs text-critical" role="alert">
              {handoffError}
            </p>
          )}
          {runs.length === 0 && (
            <p className="text-sm text-tertiary">No application runs yet.</p>
          )}
          {runs.length > 0 && (
            <div className="space-y-3">
              {runs.length === 50 && (
                <p className="text-xs text-tertiary">Showing the 50 most recent application runs.</p>
              )}
              {runs.map((r) => (
              <div key={r.id} className="bg-surface rounded-lg border border-hairline p-4 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-primary">
                    {r.atsType} · {r.mode === "auto_submit" ? "Auto-Submit" : "Fill & Prepare Packet"}
                  </span>
                    <span
                      className={`text-xs rounded-sm border px-1.5 py-0.5 font-mono text-micro uppercase tracking-wide ${
                        r.status === "submitted"
                          ? "bg-verified-quiet text-verified border-verified-line"
                          : r.status === "needs_user_action"
                            ? "bg-caution-quiet text-caution border-caution-line"
                            : r.status === "filled"
                              ? "bg-caution-quiet text-caution border-caution-line"
                              : r.status === "failed"
                                ? "bg-critical-quiet text-critical border-critical-line"
                                : "bg-n-150 text-secondary border-line"
                      }`}
                    >
                      {displayRunState(r)}
                    </span>
                  </div>
                  {r.documentStrategy && (
                    <p className="text-xs text-tertiary">
                      Resume: <span className="font-medium">{r.documentStrategy}</span>
                      {r.documentStrategyReason ? ` — ${r.documentStrategyReason}` : ""}
                    </p>
                  )}
                  {r.screenshotPath && (
                    <button
                      type="button"
                      onClick={() =>
                        setPreviewArtifact({
                          open: true,
                          url: `/api/applications/${r.id}/screenshot`,
                          title: `${job.company} · ${job.title} — Application Screenshot`,
                          filename: `screenshot-${r.id.slice(0, 8)}.png`,
                          kind: "image",
                        })
                      }
                      className="text-xs font-medium text-accent-text hover:underline"
                    >
                      View screenshot
                    </button>
                  )}
                  {(r.status === "filled" || r.status === "needs_user_action") && (
                    <button
                      onClick={() => void autonomousApplyNow()}
                      disabled={autoApplyState === "applying"}
                      className="text-xs rounded-lg bg-verified text-inverse px-3 py-1.5 disabled:opacity-40 hover:opacity-90 transition-opacity"
                    >
                      {autoApplyState === "applying" ? "Submitting…" : "Auto-Submit Now"}
                    </button>
                  )}
                  {r.status === "failed" && (
                    <button
                      onClick={() => void retryFailedRun(r.id)}
                      disabled={savingAnswerId === r.id}
                      className="text-xs rounded-lg bg-accent text-inverse px-3 py-1.5 disabled:opacity-40 hover:bg-accent-hover transition-colors"
                    >
                      {savingAnswerId === r.id ? "Retrying…" : "Retry failed run"}
                    </button>
                  )}
                  {r.confirmationNumber && (
                    <p className="text-xs text-secondary">Confirmation: {r.confirmationNumber}</p>
                  )}
                  {r.confirmationUrl && (
                    <a href={r.confirmationUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-accent-text hover:underline">
                      Confirmation page ↗
                    </a>
                  )}
                  {r.status === "filled" && (() => {
                    const last = parseStageHistory(r.stageHistory).slice(-1)[0];
                    if (!last?.detail) return null;
                    return (
                      <p className="rounded border border-caution-line bg-caution-quiet px-2.5 py-1.5 text-xs text-caution">
                        <strong>Not submitted yet:</strong> {last.detail}
                      </p>
                    );
                  })()}
                  {r.errorLog && <div className="text-xs text-critical">
                    <p>{friendlyRunError(r.errorLog)}</p>
                    <details className="mt-1 rounded border border-critical-line p-2 text-secondary">
                      <summary className="cursor-pointer font-medium">Show details</summary>
                      <pre className="mt-2 overflow-auto whitespace-pre-wrap">{r.errorLog}</pre>
                    </details>
                  </div>}
                  {(() => {
                    const stages = parseStageHistory(r.stageHistory);
                    const answers = parseRunAnswersMap(r.answers);
                    if (stages.length === 0 && answers.length === 0) return null;
                    return (
                      <details className="rounded border border-hairline bg-sunken px-3 py-2 text-xs">
                        <summary className="cursor-pointer font-medium text-secondary">
                          Inspect execution steps &amp; filled fields ({stages.length} steps, {answers.length} fields)
                        </summary>
                        <div className="mt-2 grid gap-3 sm:grid-cols-2">
                          {answers.length > 0 && (
                            <div>
                              <p className="mb-1 font-medium text-primary">Filled Fields</p>
                              <ul className="space-y-1 text-secondary">
                                {answers.map(([k, v]) => (
                                  <li key={k} className="truncate">
                                    <span className="font-medium text-primary">{k}:</span> {v}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {stages.length > 0 && (
                            <div>
                              <p className="mb-1 font-medium text-primary">Agent Timeline</p>
                              <ol className="space-y-1 text-tertiary">
                                {stages.map((s, idx) => (
                                  <li key={`${s.stage}-${idx}`}>
                                    <span className="font-mono text-primary">{s.stage}</span>
                                    {s.detail ? ` — ${s.detail}` : ""}
                                  </li>
                                ))}
                              </ol>
                            </div>
                          )}
                        </div>
                      </details>
                    );
                  })()}
                  <p className="text-xs text-faint">
                    {new Date(r.createdAt).toLocaleString()}
                    {r.finishedAt && ` – ${new Date(r.finishedAt).toLocaleString()}`}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <ArtifactPreviewModal
        open={previewArtifact.open}
        url={previewArtifact.url}
        loadBlob={previewArtifact.loadBlob}
        title={previewArtifact.title}
        filename={previewArtifact.filename}
        kind={previewArtifact.kind}
        onClose={() => setPreviewArtifact({ open: false, url: null, title: "" })}
      />

      <section className="space-y-3">
        <h2 className="font-medium text-primary">Activity timeline</h2>
        <p className="text-xs text-tertiary">
          A permanent, append-only record of every automated decision made about this job — never
          edited or deleted. This page shows the 100 most recent entries.
        </p>
        {auditLog.length === 0 ? (
          <p className="text-sm text-tertiary">No activity recorded yet.</p>
        ) : (
          <ol className="space-y-2 border-l-2 border-hairline pl-4">
            {auditLog.map((entry) => (
              <li key={entry.id} className="text-sm">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-semibold text-tertiary uppercase tracking-wide">
                    {ACTOR_LABELS[entry.actor] ?? entry.actor}
                  </span>
                  <span className="text-xs text-faint">{new Date(entry.createdAt).toLocaleString()}</span>
                </div>
                <p className="text-secondary">{entry.detail}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
