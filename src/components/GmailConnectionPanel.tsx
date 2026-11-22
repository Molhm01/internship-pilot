"use client";

import { useState } from "react";
import { CheckCircle2, MailCheck, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { GoogleSignInButton } from "@/components/GoogleSignInButton";
import { signInWithGoogleGmail, signOutGmail, useGmailAuth } from "@/lib/gmail/clientAuth";
import { toast } from "@/components/ui/Toast";

interface VerificationSummary {
  messagesScanned: number;
  linksAttempted: number;
  linksVerified: number;
  codesDetected: number;
  retrySummary?: {
    attempted: number;
    submitted: number;
    filled: number;
    failed: number;
  } | null;
}

export default function GmailConnectionPanel() {
  const gmailAuth = useGmailAuth();
  const [connecting, setConnecting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastResult, setLastResult] = useState<VerificationSummary | null>(null);
  const [lastSyncText, setLastSyncText] = useState<string | null>(null);

  async function handleSignIn() {
    setConnecting(true);
    try {
      const res = await signInWithGoogleGmail("mjalasri1@gmail.com");
      toast.success("Gmail connected", {
        description: `Connected read-only access for ${res.user.email ?? "your Gmail account"}.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not complete Google Sign-In.";
      toast.error("Google Sign-In failed", { description: msg });
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    await signOutGmail();
    setLastResult(null);
    toast.info("Gmail disconnected", {
      description: "In-memory Gmail token cleared. Sign in again anytime to auto-verify codes and links.",
    });
  }

  async function handleVerifyCodesAndLinks() {
    if (!gmailAuth.accessToken) {
      toast.error("Sign in with Google first");
      return;
    }
    setVerifying(true);
    const toastId = toast.loading("Scanning Gmail for verification links & codes, then submitting pending apps…");
    try {
      const res = await fetch("/api/gmail/verify-pending", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${gmailAuth.accessToken}`,
        },
        body: JSON.stringify({ lookbackHours: 72, retryPending: true, limit: 12 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Gmail verification failed.");
      setLastResult(data as VerificationSummary);
      const submitted = data.retrySummary?.submitted ?? 0;
      toast.success("Gmail verification complete", {
        id: toastId,
        description: `Verified ${data.linksVerified ?? 0} link(s), detected ${data.codesDetected ?? 0} OTP code(s), submitted ${submitted} application(s).`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Gmail verification failed.";
      toast.error("Verification failed", { id: toastId, description: msg });
    } finally {
      setVerifying(false);
    }
  }

  async function handleSyncInbox() {
    if (!gmailAuth.accessToken) return;
    setSyncing(true);
    const toastId = toast.loading("Syncing employer confirmations & interview emails into Tracker…");
    try {
      const res = await fetch("/api/gmail/sync", {
        method: "POST",
        headers: { Authorization: `Bearer ${gmailAuth.accessToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Inbox sync failed.");
      setLastSyncText(
        `Checked ${data.checked ?? 0} message(s) · classified ${data.classified ?? 0} · ${new Date().toLocaleTimeString()}`,
      );
      toast.success("Application emails synced", {
        id: toastId,
        description: `Checked ${data.checked ?? 0} messages and updated Tracker statuses.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Inbox sync failed.";
      toast.error("Inbox sync failed", { id: toastId, description: msg });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className="rounded-lg border border-hairline bg-surface p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <MailCheck className="size-4 text-accent" aria-hidden />
            <h2 className="font-medium text-primary">Gmail Verification &amp; Application Tracking</h2>
          </div>
          <p className="text-xs text-tertiary">
            Read-only access (<code className="font-mono">gmail.readonly</code>) — never sends, deletes, or modifies
            emails, and stores tokens strictly in memory. Allows the Autonomous Agent to read employer verification
            codes (Greenhouse, Microsoft, Workday), click account activation links, and update the Tracker.
          </p>
        </div>
        {gmailAuth.connected && (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-verified-line bg-verified-quiet px-2.5 py-1 text-xs font-medium text-verified">
            <CheckCircle2 className="size-3.5" aria-hidden />
            Connected
          </span>
        )}
      </div>

      {!gmailAuth.connected ? (
        <div className="flex flex-wrap items-center gap-4 pt-1">
          <GoogleSignInButton
            label="Sign in with Google"
            loading={connecting}
            onClick={() => void handleSignIn()}
          />
          <span className="text-xs text-tertiary">
            Recommended inbox: <span className="font-medium text-primary">mjalasri1@gmail.com</span>
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-hairline bg-sunken px-3 py-2 text-sm">
            <span className="text-secondary">
              Connected inbox: <span className="font-medium text-primary">{gmailAuth.email}</span>
            </span>
            <span className="inline-flex items-center gap-1 text-xs text-tertiary">
              <ShieldCheck className="size-3.5 text-verified" aria-hidden />
              Read-only · Session memory only
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => void handleVerifyCodesAndLinks()}
              disabled={verifying || syncing}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-inverse transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              <Sparkles className={verifying ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
              {verifying ? "Verifying Codes & Links…" : "Verify Email Codes & Links Now"}
            </button>

            <button
              type="button"
              onClick={() => void handleSyncInbox()}
              disabled={syncing || verifying}
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-primary transition-colors hover:bg-sunken disabled:opacity-50"
            >
              <RefreshCw className={syncing ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
              {syncing ? "Syncing…" : "Sync Application Emails"}
            </button>

            <button
              type="button"
              onClick={() => void handleDisconnect()}
              className="ml-auto text-sm text-critical hover:underline"
            >
              Disconnect
            </button>
          </div>

          {lastSyncText && <p className="text-xs text-tertiary">{lastSyncText}</p>}

          {lastResult && (
            <div className="rounded-md border border-verified-line bg-verified-quiet px-3 py-2 text-xs text-verified space-y-1">
              <p className="font-medium">
                Scanned {lastResult.messagesScanned} verification email(s): {lastResult.linksVerified}/
                {lastResult.linksAttempted} verification link(s) confirmed · {lastResult.codesDetected} OTP code(s)
                found.
              </p>
              {lastResult.retrySummary && (
                <p>
                  Pending application retry: {lastResult.retrySummary.submitted} submitted,{" "}
                  {lastResult.retrySummary.filled} still awaiting external action, {lastResult.retrySummary.failed}{" "}
                  failed.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
