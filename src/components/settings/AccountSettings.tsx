"use client";

import { useCallback, useEffect, useState } from "react";
import { authClient, linkSocial, signOut, unlinkAccount } from "@/lib/auth/client";

/**
 * Account settings: who you are, how you sign in, and what is connected.
 *
 * Two rules shape this screen.
 *
 * **Google is connected here, never at sign-in.** Implicit linking is disabled
 * on the server, so the only way an OAuth identity joins an account is a
 * deliberate click by somebody already signed in as that account. That is the
 * whole point: matching email addresses is not proof of the same person.
 *
 * **No database ids.** Not the user id, not a session id, not a token id. They
 * are meaningless to the person reading and useful to anybody looking over
 * their shoulder; sessions are identified by device and time instead.
 */

/** Shaped from what the auth client returns, not invented alongside it. */
type LinkedAccount = { id: string; accountId: string; providerId: string };
type SessionRow = { id: string; token: string; createdAt: Date; userAgent?: string | null };
type ExtensionToken = {
  id: string;
  tokenHint: string;
  label: string;
  lastUsedAt: string | null;
  createdAt: string;
};

function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\/|Opera/.test(userAgent)
      ? "Opera"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : /Firefox\//.test(userAgent)
            ? "Firefox"
            : "Browser";
  const platform = /Windows/.test(userAgent)
    ? "Windows"
    : /Mac OS X|Macintosh/.test(userAgent)
      ? "macOS"
      : /Android/.test(userAgent)
        ? "Android"
        : /iPhone|iPad/.test(userAgent)
          ? "iOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "";
  return platform ? `${browser} on ${platform}` : browser;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10 border-t border-hairline pt-8">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-tertiary">{title}</h2>
      {description && <p className="mt-2 max-w-prose text-sm text-secondary">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default function AccountSettings({
  name,
  email,
  googleEnabled,
}: {
  name: string;
  email: string;
  googleEnabled: boolean;
}) {
  const [accounts, setAccounts] = useState<LinkedAccount[] | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [tokens, setTokens] = useState<ExtensionToken[] | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [accountResult, sessionResult, tokenResponse] = await Promise.all([
      authClient.listAccounts(),
      authClient.listSessions(),
      fetch("/api/extension/tokens").then((response) => (response.ok ? response.json() : null)),
    ]);
    setAccounts(accountResult.data ?? []);
    setSessions(sessionResult.data ?? []);
    setTokens((tokenResponse?.tokens as ExtensionToken[] | undefined) ?? []);
  }, []);

  useEffect(() => {
    void refresh().catch(() => setError("Could not load your account details."));
  }, [refresh]);

  const googleAccount = accounts?.find((account) => account.providerId === "google") ?? null;
  const googleLinked = googleAccount !== null;
  const passwordSet = accounts?.some((account) => account.providerId === "credential") ?? false;
  // The last remaining sign-in method may not be removed; the server refuses
  // it too, and the button should not pretend otherwise.
  const canUnlinkGoogle = googleLinked && passwordSet;

  async function connectGoogle() {
    setError(null);
    setBusy(true);
    try {
      await linkSocial({ provider: "google", callbackURL: "/settings" });
    } catch {
      setError("Google could not be connected. Try again.");
      setBusy(false);
    }
  }

  async function disconnectGoogle() {
    setError(null);
    if (!googleAccount) {
      setError("Google is not connected to this account.");
      return;
    }
    setBusy(true);
    try {
      // `providerId` is required; `accountId` narrows it to one specific link
      // when the same provider is connected more than once. It is the
      // provider's own account id from listAccounts(), not the row id — passing
      // the row id there matches nothing and the unlink silently does nothing.
      const result = await unlinkAccount({
        providerId: "google",
        accountId: googleAccount.accountId,
      });
      if (result.error) setError(result.error.message ?? "Google could not be disconnected.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function revokeSession(token: string) {
    setBusy(true);
    try {
      await authClient.revokeSession({ token });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function signOutEverywhere() {
    setBusy(true);
    try {
      await authClient.revokeOtherSessions();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function createToken() {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/extension/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Browser extension" }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error ?? "The token could not be created.");
        return;
      }
      setFreshToken(data.token as string);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/extension/tokens?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error && (
        <p
          role="alert"
          className="mt-6 rounded-lg border border-critical-line bg-critical-quiet px-3 py-2 text-sm text-critical"
        >
          {error}
        </p>
      )}

      <Section title="Account">
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between gap-6">
            <dt className="text-secondary">Name</dt>
            <dd className="text-primary">{name || "—"}</dd>
          </div>
          <div className="flex justify-between gap-6">
            <dt className="text-secondary">Email</dt>
            <dd className="text-primary">{email}</dd>
          </div>
        </dl>
      </Section>

      <Section
        title="How you sign in"
        description="One account can have more than one way in. Connecting Google here links it to this account; signing in with Google before connecting it would create a separate account, which is deliberate — a matching email address is not proof of the same person."
      >
        <ul className="space-y-3 text-sm">
          <li className="flex items-center justify-between gap-6">
            <span className="text-primary">
              Email and password
              {!passwordSet && <span className="ml-2 text-tertiary">Not set</span>}
            </span>
            <span className="text-tertiary">{passwordSet ? "Active" : "—"}</span>
          </li>
          <li className="flex items-center justify-between gap-6">
            <span className="text-primary">Google</span>
            {!googleEnabled ? (
              <span className="text-tertiary">Not available on this deployment</span>
            ) : googleLinked ? (
              <span className="flex items-center gap-3">
                <span className="text-tertiary">Connected</span>
                <button
                  type="button"
                  onClick={() => void disconnectGoogle()}
                  disabled={busy || !canUnlinkGoogle}
                  title={
                    canUnlinkGoogle
                      ? undefined
                      : "Set a password first — an account must keep at least one way to sign in."
                  }
                  className="rounded-md border border-hairline px-2.5 py-1 text-xs text-secondary hover:bg-surface-hover disabled:opacity-40"
                >
                  Disconnect
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void connectGoogle()}
                disabled={busy}
                className="rounded-md border border-hairline px-2.5 py-1 text-xs text-secondary hover:bg-surface-hover disabled:opacity-40"
              >
                Connect Google
              </button>
            )}
          </li>
        </ul>
      </Section>

      <Section
        title="Sessions"
        description="Every browser currently signed in to this account. Revoking one signs that browser out immediately — the session is ended on the server, not just locally."
      >
        {sessions === null ? (
          <p className="text-sm text-tertiary">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-tertiary">No other sessions.</p>
        ) : (
          <ul className="space-y-3 text-sm">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-center justify-between gap-6">
                <span className="text-primary">
                  {describeDevice(session.userAgent)}
                  <span className="ml-2 text-tertiary">
                    since {new Date(session.createdAt).toLocaleDateString()}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void revokeSession(session.token)}
                  disabled={busy}
                  className="rounded-md border border-hairline px-2.5 py-1 text-xs text-secondary hover:bg-surface-hover disabled:opacity-40"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={() => void signOutEverywhere()}
            disabled={busy}
            className="rounded-lg border border-hairline px-3 py-2 text-sm text-secondary hover:bg-surface-hover disabled:opacity-40"
          >
            Sign out other sessions
          </button>
          <button
            type="button"
            onClick={() => void signOut()}
            disabled={busy}
            className="rounded-lg border border-hairline px-3 py-2 text-sm text-secondary hover:bg-surface-hover disabled:opacity-40"
          >
            Sign out
          </button>
        </div>
      </Section>

      <Section
        title="Browser extension"
        description="A token connects the extension to this account, and only this account. It is shown once — only its fingerprint is stored here, so a copy of the database cannot be used to impersonate your extension."
      >
        {freshToken && (
          <div className="mb-4 rounded-lg border border-hairline bg-surface p-3">
            <p className="text-xs text-secondary">
              Copy this now. It will not be shown again.
            </p>
            <code className="mt-2 block break-all rounded bg-surface-hover px-2 py-1.5 text-xs text-primary">
              {freshToken}
            </code>
          </div>
        )}
        {tokens === null ? (
          <p className="text-sm text-tertiary">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-tertiary">No extension is connected to this account.</p>
        ) : (
          <ul className="space-y-3 text-sm">
            {tokens.map((token) => (
              <li key={token.id} className="flex items-center justify-between gap-6">
                <span className="text-primary">
                  {token.label}
                  <span className="ml-2 font-mono text-xs text-tertiary">{token.tokenHint}</span>
                  <span className="ml-2 text-tertiary">
                    {token.lastUsedAt
                      ? `last used ${new Date(token.lastUsedAt).toLocaleDateString()}`
                      : "never used"}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void revokeToken(token.id)}
                  disabled={busy}
                  className="rounded-md border border-hairline px-2.5 py-1 text-xs text-secondary hover:bg-surface-hover disabled:opacity-40"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={() => void createToken()}
          disabled={busy}
          className="mt-5 rounded-lg border border-hairline px-3 py-2 text-sm text-secondary hover:bg-surface-hover disabled:opacity-40"
        >
          Generate extension token
        </button>
      </Section>
    </div>
  );
}
