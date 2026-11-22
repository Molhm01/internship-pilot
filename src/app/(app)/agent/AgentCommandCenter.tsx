"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  KeyRound,
  MailCheck,
  PauseCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Zap,
} from "lucide-react";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { Metric, MetricRow } from "@/components/ui/Metric";
import { Panel, Section } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/State";
import { ArtifactPreviewModal } from "@/components/ui/ArtifactPreviewModal";
import { toast } from "@/components/ui/Toast";
import { GoogleSignInButton } from "@/components/GoogleSignInButton";
import { signInWithGoogleGmail, signOutGmail, useGmailAuth } from "@/lib/gmail/clientAuth";

interface AutopilotConfig {
  enabled: boolean;
  mode: "auto_submit" | "fill_to_submit";
  minScore: number;
  maxPerCycle: number;
  discoverFresh: boolean;
}

interface CycleSummary {
  ranAt: string;
  mode: string;
  discovered: number;
  scored: number;
  attempted: number;
  submitted: number;
  filled: number;
  needsUserAction: number;
  failed: number;
}

interface ApplicationRunItem {
  id: string;
  jobId: string;
  jobTitle: string;
  company: string;
  location: string | null;
  applyUrl: string | null;
  atsType: string;
  mode: string;
  status: string;
  currentStep: string | null;
  matchScoreAtRun: number | null;
  documentStrategy: string | null;
  documentStrategyReason: string | null;
  resumeDocumentId: string | null;
  coverLetterDocumentId: string | null;
  confirmationNumber: string | null;
  confirmationUrl: string | null;
  screenshotPath: string | null;
  needsUserActionReason: string | null;
  stoppedFieldLabel: string | null;
  stoppedFieldType: string | null;
  stoppedFieldOptions: string[];
  answers: Record<string, string>;
  stageHistory: Array<{ stage: string; at: string; detail?: string }>;
  errorLog: string | null;
  attemptNumber: number;
  createdAt: string;
  startedAt?: string | null;
  finishedAt: string | null;
}

interface ApplicationsPayload {
  runs: ApplicationRunItem[];
  metrics: {
    activeJobs: number;
    scoredJobs: number;
    totalRuns: number;
    submitted: number;
    filled: number;
    needsUserAction: number;
    failed: number;
    running: number;
  };
  autopilotConfig: AutopilotConfig;
  portalCredentials?: { email: string; password: string };
  gmailConnected?: boolean;
  lastSummary: CycleSummary | null;
}

function statusBadge(status: string) {
  switch (status) {
    case "submitted":
      return <Badge tone="positive">Submitted ✓</Badge>;
    case "filled":
      return <Badge tone="caution">Not Submitted — Action Required</Badge>;
    case "failed":
      return <Badge tone="critical">Failed</Badge>;
    case "running":
    case "queued":
    case "needs_user_action":
      return <Badge tone="accent">Retrying Autonomously</Badge>;
    default:
      return <Badge tone="neutral">{status}</Badge>;
  }
}

export function AgentCommandCenter() {
  const gmailAuth = useGmailAuth();
  const [data, setData] = useState<ApplicationsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningCycle, setRunningCycle] = useState(false);
  const [retryingPending, setRetryingPending] = useState(false);
  const [verifyingGmail, setVerifyingGmail] = useState(false);
  const [connectingGmail, setConnectingGmail] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [credEmail, setCredEmail] = useState("mjalasri1@gmail.com");
  const [credPassword, setCredPassword] = useState("Molhmiscool21!");
  const [showCredPassword, setShowCredPassword] = useState(false);
  const [savingCreds, setSavingCreds] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "submitted" | "filled" | "failed">("all");
  const [actingRunId, setActingRunId] = useState<string | null>(null);
  const [previewArtifact, setPreviewArtifact] = useState<{
    open: boolean;
    url: string | null;
    title: string;
    filename?: string;
    kind?: "image" | "pdf";
  }>({ open: false, url: null, title: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/applications");
      if (!res.ok) throw new Error("Could not load autonomous agent workspace.");
      const payload = (await res.json()) as ApplicationsPayload;
      setData(payload);
      if (payload.portalCredentials) {
        setCredEmail(payload.portalCredentials.email);
        setCredPassword(payload.portalCredentials.password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load applications.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const jsonHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (gmailAuth.accessToken) {
      headers.Authorization = `Bearer ${gmailAuth.accessToken}`;
    }
    return headers;
  }, [gmailAuth.accessToken]);

  const connectGmail = useCallback(async () => {
    setConnectingGmail(true);
    setError(null);
    try {
      const res = await signInWithGoogleGmail(credEmail.trim() || "mjalasri1@gmail.com");
      toast.success("Gmail connected for automatic verification", {
        description: `Connected ${res.user.email ?? "Gmail"} (read-only). Autonomous runs will now auto-read OTP codes and click verification links.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not sign in with Google.";
      setError(msg);
      toast.error("Google Sign-In failed", { description: msg });
    } finally {
      setConnectingGmail(false);
    }
  }, [credEmail]);

  const disconnectGmail = useCallback(async () => {
    await signOutGmail();
    toast.info("Gmail disconnected", {
      description: "In-memory token cleared. Click 'Sign in with Google' anytime to reconnect.",
    });
  }, []);

  const verifyGmailCodesAndLinks = useCallback(async () => {
    if (!gmailAuth.accessToken) {
      toast.error("Sign in with Google first", {
        description: "Connect mjalasri1@gmail.com so the agent can verify codes and links.",
      });
      return;
    }
    if (verifyingGmail || runningCycle || retryingPending) return;
    setVerifyingGmail(true);
    setError(null);
    const toastId = toast.loading("Scanning Gmail for verification links & codes, verifying accounts, and submitting pending apps…");
    try {
      const res = await fetch("/api/gmail/verify-pending", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ lookbackHours: 72, retryPending: true, limit: 15 }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Gmail verification failed.");
      const s = json.retrySummary;
      toast.success("Email verification & submission pass complete", {
        id: toastId,
        description: `Verified ${json.linksVerified ?? 0} link(s) · detected ${json.codesDetected ?? 0} OTP code(s)${
          s ? ` · submitted ${s.submitted} of ${s.attempted} retried` : ""
        }.`,
      });
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Gmail verification failed.";
      setError(msg);
      toast.error("Gmail verification failed", { id: toastId, description: msg });
    } finally {
      setVerifyingGmail(false);
    }
  }, [gmailAuth.accessToken, jsonHeaders, load, retryingPending, runningCycle, verifyingGmail]);

  const updateConfig = useCallback(async (patch: Partial<AutopilotConfig>) => {
    setSavingConfig(true);
    setError(null);
    try {
      const res = await fetch("/api/agent/autopilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_config", ...patch }),
      });
      if (!res.ok) throw new Error("Failed to save Auto-Pilot settings.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save configuration.");
    } finally {
      setSavingConfig(false);
    }
  }, [load]);

  const savePortalCredentials = useCallback(async () => {
    setSavingCreds(true);
    setError(null);
    const toastId = toast.loading("Saving employer portal signup credentials…");
    try {
      const res = await fetch("/api/agent/autopilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_credentials",
          email: credEmail.trim(),
          password: credPassword,
        }),
      });
      if (!res.ok) throw new Error("Failed to save portal credentials.");
      toast.success("Portal signup credentials saved", {
        id: toastId,
        description: `Agent will create/sign in to employer portals with ${credEmail.trim()}.`,
      });
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save portal credentials.";
      setError(msg);
      toast.error("Could not save credentials", { id: toastId, description: msg });
    } finally {
      setSavingCreds(false);
    }
  }, [credEmail, credPassword, load]);

  const discoverAllNow = useCallback(async () => {
    if (discovering || runningCycle) return;
    setDiscovering(true);
    setError(null);
    const toastId = toast.loading("Scanning live ATS boards for new engineering internships…");
    try {
      const res = await fetch("/api/agent/autopilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "discover" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Discovery sweep failed.");
      toast.success("Discovery sweep complete", {
        id: toastId,
        description: `Discovered ${json.discovered ?? 0} postings · scored ${json.scored ?? 0}.`,
      });
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Discovery sweep failed.";
      setError(msg);
      toast.error("Discovery sweep failed", { id: toastId, description: msg });
    } finally {
      setDiscovering(false);
    }
  }, [discovering, load, runningCycle]);

  const runCycleNow = useCallback(async () => {
    if (runningCycle) return;
    setRunningCycle(true);
    setError(null);
    const toastId = toast.loading("Running autonomous discovery, tailoring & submission cycle…");
    try {
      const res = await fetch("/api/agent/autopilot", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ action: "run_cycle" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Autonomous cycle failed.");
      const s = json.summary;
      toast.success("Autonomous cycle finished", {
        id: toastId,
        description: s
          ? `Attempted ${s.attempted}: ${s.submitted} submitted, ${s.filled} prepared (not submitted), ${s.failed} paused.`
          : "Cycle finished cleanly.",
      });
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Autonomous cycle failed.";
      setError(msg);
      toast.error("Autonomous cycle failed", { id: toastId, description: msg });
    } finally {
      setRunningCycle(false);
    }
  }, [jsonHeaders, load, runningCycle]);

  const retryAllPending = useCallback(async () => {
    if (retryingPending || runningCycle || discovering) return;
    setRetryingPending(true);
    setError(null);
    const toastId = toast.loading("Retrying all unsubmitted applications in Auto-Submit mode…");
    try {
      const res = await fetch("/api/agent/autopilot", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ action: "retry_pending", limit: 15 }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Retry batch failed.");
      const s = json.summary;
      toast.success("Retry batch finished", {
        id: toastId,
        description: s
          ? `Retried ${s.attempted}: ${s.submitted} submitted, ${s.filled} awaiting verification/CAPTCHA, ${s.failed} failed.`
          : "Retry batch completed.",
      });
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Retry batch failed.";
      setError(msg);
      toast.error("Retry batch failed", { id: toastId, description: msg });
    } finally {
      setRetryingPending(false);
    }
  }, [discovering, jsonHeaders, load, retryingPending, runningCycle]);

  // Continuous background Auto-Pilot tick when enabled
  useEffect(() => {
    if (!data?.autopilotConfig.enabled) return;
    const timer = window.setInterval(() => {
      if (!runningCycle) void runCycleNow();
    }, 90_000);
    return () => window.clearInterval(timer);
  }, [data?.autopilotConfig.enabled, runCycleNow, runningCycle]);

  async function retryRun(runId: string) {
    setActingRunId(runId);
    setError(null);
    const toastId = toast.loading("Retrying autonomous application…");
    try {
      const res = await fetch(`/api/applications/${runId}/retry`, {
        method: "POST",
        headers: gmailAuth.accessToken ? { Authorization: `Bearer ${gmailAuth.accessToken}` } : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not retry run.");
      const msg = typeof json.detail === "string" ? json.detail : "Retry finished.";
      if (json.status === "submitted") {
        toast.success("Application submitted", { id: toastId, description: msg });
      } else if (json.status === "failed") {
        toast.error("Retry paused", { id: toastId, description: msg });
      } else {
        toast.info("Packet prepared", { id: toastId, description: msg });
      }
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Retry failed.";
      setError(msg);
      toast.error("Retry failed", { id: toastId, description: msg });
    } finally {
      setActingRunId(null);
    }
  }

  async function submitFilledPacket(jobId: string, runId: string) {
    setActingRunId(runId);
    setError(null);
    const toastId = toast.loading("Executing Auto-Submit…");
    try {
      const res = await fetch(`/api/jobs/${jobId}/apply`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ mode: "auto_submit" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Autonomous submit failed.");
      const msg = typeof json.detail === "string" ? json.detail : "Auto-Submit finished.";
      if (json.status === "submitted") {
        toast.success("Application submitted", { id: toastId, description: msg });
      } else if (json.status === "failed") {
        toast.error("Auto-Submit paused", { id: toastId, description: msg });
      } else {
        toast.info("Packet updated", { id: toastId, description: msg });
      }
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Autonomous submit failed.";
      setError(msg);
      toast.error("Auto-Submit failed", { id: toastId, description: msg });
    } finally {
      setActingRunId(null);
    }
  }

  const config = data?.autopilotConfig;
  const metrics = data?.metrics;
  const runs = data?.runs ?? [];
  const visibleRuns = filter === "all" ? runs : runs.filter((r) => r.status === filter);

  return (
    <PageBody>
      <PageHeader
        title="Autonomous Application Agent"
        description="Discovers live engineering internships, scores ATS fit, tailors QA-verified PDFs, inspects live ATS forms, and executes remote or local submissions autonomously."
        actions={
          <>
            <Button size="md" onClick={() => void load()} disabled={loading || runningCycle || discovering || retryingPending}>
              <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
              Refresh
            </Button>
            {metrics && (metrics.filled > 0 || metrics.failed > 0) && (
              <Button
                size="md"
                onClick={() => void retryAllPending()}
                disabled={retryingPending || runningCycle || discovering || loading}
              >
                <RotateCcw className={retryingPending ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
                {retryingPending
                  ? "Retrying Unsubmitted…"
                  : `Retry All Unsubmitted (${metrics.filled + metrics.failed})`}
              </Button>
            )}
            <Button
              size="md"
              onClick={() => void discoverAllNow()}
              disabled={discovering || runningCycle || retryingPending || loading}
            >
              <Sparkles className="size-3.5" aria-hidden />
              {discovering ? "Locating Internships…" : "Locate All Internships"}
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => void runCycleNow()}
              disabled={runningCycle || discovering || retryingPending || loading}
            >
              {runningCycle ? (
                <>
                  <RefreshCw className="size-3.5 animate-spin" aria-hidden />
                  Running Autonomous Cycle…
                </>
              ) : (
                <>
                  <Play className="size-3.5" aria-hidden />
                  Run Autonomous Cycle Now
                </>
              )}
            </Button>
          </>
        }
      />

      {error && (
        <ErrorState
          title="Agent action error"
          message={error}
          onRetry={() => void load()}
          className="mb-6"
        />
      )}

      {metrics && (
        <Panel flush className="mb-6">
          <MetricRow className="px-4 py-1">
            <Metric label="Active Internships" value={metrics.activeJobs.toLocaleString()} tone="accent" />
            <Metric label="Scored" value={metrics.scoredJobs.toLocaleString()} />
            <Metric label="Submitted" value={metrics.submitted.toLocaleString()} tone="positive" />
            <Metric label="Not Submitted (Action Needed)" value={metrics.filled.toLocaleString()} tone="caution" />
            <Metric label="Total Runs" value={metrics.totalRuns.toLocaleString()} />
          </MetricRow>
        </Panel>
      )}

      {config && (
        <Panel className="mb-8 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-lg border border-accent/30 bg-accent-quiet text-accent">
                <Bot className="size-4" aria-hidden />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-subhead font-medium text-primary">Auto-Pilot Mode</h2>
                  <Badge tone={config.enabled ? "positive" : "neutral"}>
                    {config.enabled ? "Active · 90s Loop" : "On-Demand"}
                  </Badge>
                </div>
                <p className="text-small text-tertiary">
                  Automatically discovers postings, scores eligibility, compiles tailored PDFs, and executes applications above your score floor.
                </p>
              </div>
            </div>

            <Button
              variant={config.enabled ? "danger" : "primary"}
              size="md"
              disabled={savingConfig}
              onClick={() => void updateConfig({ enabled: !config.enabled })}
            >
              {config.enabled ? (
                <>
                  <PauseCircle className="size-3.5" aria-hidden />
                  Pause Auto-Pilot
                </>
              ) : (
                <>
                  <Zap className="size-3.5" aria-hidden />
                  Enable Continuous Auto-Pilot
                </>
              )}
            </Button>
          </div>

          <div className="grid gap-4 border-t border-hairline pt-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1 text-small">
              <span className="block text-micro font-medium text-tertiary">Execution Mode</span>
              <select
                value="auto_submit"
                disabled={savingConfig}
                onChange={() => void updateConfig({ mode: "auto_submit" })}
                className="h-8 w-full rounded-md border border-line bg-surface px-2.5 text-small text-primary"
              >
                <option value="auto_submit">Autonomous Submit (Full Auto)</option>
              </select>
            </label>

            <label className="space-y-1 text-small">
              <span className="block text-micro font-medium text-tertiary">
                Minimum Match Score ({config.minScore}%)
              </span>
              <input
                type="range"
                min={0}
                max={95}
                step={5}
                value={config.minScore}
                onChange={(e) => void updateConfig({ minScore: Number(e.target.value) })}
                className="w-full accent-accent"
              />
            </label>

            <label className="space-y-1 text-small">
              <span className="block text-micro font-medium text-tertiary">Max Applications / Cycle</span>
              <select
                value={config.maxPerCycle}
                disabled={savingConfig}
                onChange={(e) => void updateConfig({ maxPerCycle: Number(e.target.value) })}
                className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-small text-primary"
              >
                {[1, 3, 5, 10, 15, 25].map((n) => (
                  <option key={n} value={n}>
                    Up to {n} per cycle
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 self-end pb-1.5 text-small text-secondary">
              <input
                type="checkbox"
                checked={config.discoverFresh}
                disabled={savingConfig}
                onChange={(e) => void updateConfig({ discoverFresh: e.target.checked })}
              />
              Refresh live ATS boards on cycle
            </label>
          </div>

          <div className="rounded-md border border-hairline bg-sunken p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <KeyRound className="size-3.5 text-accent" aria-hidden />
                <span className="text-small font-medium text-primary">
                  Employer Portal Account Creation &amp; Gmail Auto-Verification
                </span>
              </div>
              {gmailAuth.connected ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="positive">
                    Gmail Connected · {gmailAuth.email}
                  </Badge>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={verifyingGmail || runningCycle || retryingPending}
                    onClick={() => void verifyGmailCodesAndLinks()}
                  >
                    <MailCheck className={verifyingGmail ? "size-3 animate-spin" : "size-3"} aria-hidden />
                    {verifyingGmail ? "Verifying Inbox…" : "Verify Email Codes & Links"}
                  </Button>
                  <button
                    type="button"
                    onClick={() => void disconnectGmail()}
                    className="text-micro text-tertiary hover:text-critical hover:underline"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-micro text-secondary">
                    Sign in to read OTP codes &amp; click verification links automatically:
                  </span>
                  <GoogleSignInButton
                    compact
                    label="Sign in with Google"
                    loading={connectingGmail}
                    onClick={() => void connectGmail()}
                  />
                </div>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] items-end">
              <label className="space-y-1 text-micro">
                <span className="block font-medium text-tertiary">Portal Signup Email</span>
                <input
                  type="email"
                  value={credEmail}
                  onChange={(e) => setCredEmail(e.target.value)}
                  className="h-8 w-full rounded-md border border-line bg-surface px-2.5 text-small text-primary"
                />
              </label>
              <label className="space-y-1 text-micro">
                <span className="block font-medium text-tertiary">Portal Account Password</span>
                <div className="relative">
                  <input
                    type={showCredPassword ? "text" : "password"}
                    value={credPassword}
                    onChange={(e) => setCredPassword(e.target.value)}
                    className="h-8 w-full rounded-md border border-line bg-surface pl-2.5 pr-8 text-small text-primary"
                  />
                  <button
                    type="button"
                    aria-label={showCredPassword ? "Hide password" : "Show password"}
                    onClick={() => setShowCredPassword((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-tertiary hover:text-primary"
                  >
                    {showCredPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
              </label>
              <Button size="sm" disabled={savingCreds} onClick={() => void savePortalCredentials()}>
                {savingCreds ? "Saving…" : "Save Portal Login"}
              </Button>
            </div>
          </div>

          {data?.lastSummary && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-md border border-hairline bg-sunken px-3 py-2 text-micro text-secondary">
              <span className="flex items-center gap-1 font-medium text-primary">
                <Sparkles className="size-3 text-accent" aria-hidden />
                Last cycle ({new Date(data.lastSummary.ranAt).toLocaleString()}):
              </span>
              <span>{data.lastSummary.discovered} discovered</span>
              <span>{data.lastSummary.scored} scored</span>
              <span>{data.lastSummary.attempted} attempted</span>
              <span className="text-verified">{data.lastSummary.submitted} submitted</span>
              <span className="text-caution">{data.lastSummary.filled} prepared (not submitted)</span>
            </div>
          )}
        </Panel>
      )}

      <Section
        title="Application Execution History"
        description="Every autonomous attempt with prepared field answers, tailored PDFs, and real ATS outcomes."
        actions={
          <div className="flex flex-wrap items-center gap-1">
            {(["all", "submitted", "filled", "failed"] as const).map((tab) => (
              <Button
                key={tab}
                size="sm"
                variant={filter === tab ? "primary" : "ghost"}
                onClick={() => setFilter(tab)}
              >
                {tab === "all"
                  ? "All"
                  : tab === "filled"
                    ? "Not Submitted"
                    : tab.charAt(0).toUpperCase() + tab.slice(1)}
              </Button>
            ))}
          </div>
        }
      >
        {loading ? (
          <SkeletonRows rows={4} />
        ) : visibleRuns.length === 0 ? (
          <EmptyState
            title="No autonomous application runs yet"
            description="Click 'Run Autonomous Cycle Now' above to discover roles, tailor your PDFs, and apply automatically."
            action={
              <Button variant="primary" size="md" onClick={() => void runCycleNow()}>
                <Play className="size-3.5" aria-hidden />
                Run First Cycle
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            {visibleRuns.map((run) => {
              const answerEntries = Object.entries(run.answers);
              const lastStage = run.stageHistory[run.stageHistory.length - 1];
              return (
                <Panel key={run.id} className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/jobs/${run.jobId}`}
                          className="text-subhead font-medium text-primary hover:text-accent-text hover:underline"
                        >
                          {run.jobTitle}
                        </Link>
                        {statusBadge(run.status)}
                        {run.matchScoreAtRun !== null && (
                          <Badge tone="neutral">{run.matchScoreAtRun}% Fit</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-small text-tertiary">
                        {run.company}
                        {run.location ? ` · ${run.location}` : ""} ·{" "}
                        <span className="font-mono uppercase">{run.atsType}</span> ·{" "}
                        {run.mode === "auto_submit" ? "Autonomous Submit" : "Fill & Review"}
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
                              title: `${run.company} · ${run.jobTitle} — Screenshot`,
                              filename: `screenshot-${run.id.slice(0, 8)}.png`,
                              kind: "image",
                            })
                          }
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2 text-micro font-medium text-secondary hover:bg-n-150"
                        >
                          Screenshot
                        </button>
                      )}
                      {run.applyUrl && (
                        <a
                          href={run.applyUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2 text-micro font-medium text-accent-text hover:bg-n-150"
                        >
                          Apply Link
                          <ExternalLink className="size-3" aria-hidden />
                        </a>
                      )}
                      {run.status === "filled" && (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={actingRunId === run.id}
                          onClick={() => void submitFilledPacket(run.jobId, run.id)}
                        >
                          <Zap className="size-3" aria-hidden />
                          {actingRunId === run.id ? "Submitting…" : "Auto-Submit Now"}
                        </Button>
                      )}
                      {run.status === "failed" && (
                        <Button
                          size="sm"
                          disabled={actingRunId === run.id}
                          onClick={() => void retryRun(run.id)}
                        >
                          <RotateCcw className="size-3" aria-hidden />
                          {actingRunId === run.id ? "Retrying…" : "Retry"}
                        </Button>
                      )}
                    </div>
                  </div>

                  {run.confirmationNumber && (
                    <div className="flex flex-wrap items-center gap-2 rounded-md border border-verified-line bg-verified-quiet px-3 py-1.5 text-micro text-verified">
                      <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
                      <span>Confirmation: {run.confirmationNumber}</span>
                      {run.confirmationUrl && (
                        <a
                          href={run.confirmationUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        >
                          Open confirmation
                        </a>
                      )}
                    </div>
                  )}

                  {run.status === "filled" && (
                    <div className="flex items-start gap-2 rounded-md border border-caution-line bg-caution-quiet px-3 py-1.5 text-micro text-caution">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      <span>
                        <strong>Not submitted yet:</strong>{" "}
                        {lastStage?.detail || "Portal requires account verification, CAPTCHA, or manual final click — check Apply Link or click Auto-Submit Now."}
                      </span>
                    </div>
                  )}

                  {run.errorLog && run.status === "failed" && (
                    <p className="rounded-md border border-critical-line bg-critical-quiet px-3 py-1.5 text-micro text-critical">
                      {run.errorLog}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-4 text-micro text-tertiary">
                    <span>
                      Started: {new Date(run.startedAt ?? run.createdAt).toLocaleString()}
                    </span>
                    {run.finishedAt && (
                      <span>Finished: {new Date(run.finishedAt).toLocaleString()}</span>
                    )}
                    {answerEntries.length > 0 && (
                      <span>{answerEntries.length} fields resolved</span>
                    )}
                  </div>

                  {(answerEntries.length > 0 || run.stageHistory.length > 0) && (
                    <details className="rounded-md border border-hairline bg-sunken px-3 py-2 text-micro">
                      <summary className="cursor-pointer font-medium text-secondary">
                        Inspect field answers &amp; stage timeline ({run.stageHistory.length} steps)
                      </summary>
                      <div className="mt-2 grid gap-4 md:grid-cols-2">
                        <div>
                          <p className="mb-1 font-medium text-primary">Prepared ATS Answers</p>
                          {answerEntries.length === 0 ? (
                            <p className="text-tertiary">No form fields captured.</p>
                          ) : (
                            <ul className="space-y-1 text-secondary">
                              {answerEntries.map(([field, val]) => (
                                <li key={field} className="truncate">
                                  <span className="font-medium text-primary">{field}:</span> {val}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div>
                          <p className="mb-1 font-medium text-primary">Execution Timeline</p>
                          <ol className="space-y-1 text-tertiary">
                            {run.stageHistory.map((step, i) => (
                              <li key={`${step.stage}-${i}`}>
                                <span className="font-mono text-primary">{step.stage}</span>
                                {step.detail ? ` — ${step.detail}` : ""}
                              </li>
                            ))}
                          </ol>
                        </div>
                      </div>
                    </details>
                  )}
                </Panel>
              );
            })}
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
