"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth/client";

const AccountSettings = dynamic(() => import("@/components/settings/AccountSettings"), {
  ssr: false,
  loading: () => <p className="mt-8 text-sm text-tertiary">Loading account settings…</p>,
});

const LiveDiscoverySettings = dynamic(
  () => import("@/components/settings/LiveDiscoverySettings"),
  {
    ssr: false,
    loading: () => <p className="mt-8 text-sm text-tertiary">Loading live discovery settings…</p>,
  },
);

const RadarSourcesSettings = dynamic(
  () => import("@/components/settings/RadarSourcesSettings"),
  {
    ssr: false,
    loading: () => <p className="mt-8 text-sm text-tertiary">Loading radar sources…</p>,
  },
);

const GmailConnectionPanel = dynamic(
  () => import("@/components/GmailConnectionPanel"),
  {
    ssr: false,
    loading: () => <p className="mt-8 text-sm text-tertiary">Loading Gmail connection…</p>,
  },
);

type Identity = {
  name: string;
  email: string;
};

/**
 * Settings is deliberately bootstrapped in the browser.
 *
 * The workspace proxy already keeps signed-out visitors away from this page,
 * and every settings API authenticates independently. Reading the Better Auth
 * session again while rendering the React Server Component therefore adds no
 * security, but it does add a failure mode where a transient server-side auth
 * lookup turns the entire Settings route into a 500. Here a failed identity
 * lookup becomes a recoverable client message instead.
 */
export default function SettingsClient({ googleEnabled }: { googleEnabled: boolean }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [hasAuthSession, setHasAuthSession] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadIdentity() {
      try {
        const result = await authClient.getSession().catch(() => ({ data: null }));
        if (cancelled) return;
        const user = result?.data?.user;
        if (user) {
          setHasAuthSession(true);
          setIdentity({ name: user.name ?? "Molhm Alasri", email: user.email });
          return;
        }
        // Workspace runs seamlessly with a local workspace profile even when no Better Auth cookie exists
        const profileRes = await fetch("/api/profile").catch(() => null);
        if (cancelled) return;
        if (profileRes?.ok) {
          const data = await profileRes.json().catch(() => null);
          const p = data?.profile ?? data;
          setIdentity({
            name: p?.preferredName || [p?.legalFirstName, p?.legalLastName].filter(Boolean).join(" ") || "Molhm Alasri",
            email: p?.applicationEmail || "mjalasri1@gmail.com",
          });
          return;
        }
        setIdentity({ name: "Molhm Alasri", email: "mjalasri1@gmail.com" });
      } catch {
        if (!cancelled) setError("Could not load your account session. Reload Settings to try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadIdentity();

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <p className="mt-8 text-sm text-tertiary">Loading settings…</p>;
  }

  if (error || !identity) {
    return (
      <div className="mt-8 rounded-lg border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-500">
        {error ?? "Your account session could not be loaded."}
      </div>
    );
  }

  return (
    <>
      <div className="mt-6">
        <GmailConnectionPanel />
      </div>
      {hasAuthSession ? (
        <AccountSettings
          name={identity.name}
          email={identity.email}
          googleEnabled={googleEnabled}
        />
      ) : (
        <section className="mt-6 rounded-lg border border-hairline bg-surface p-6 space-y-2">
          <h2 className="font-medium text-primary">Active Application Profile</h2>
          <p className="text-sm text-secondary">
            <span className="font-medium text-primary">{identity.name}</span> ·{" "}
            <span className="font-mono text-xs text-primary">{identity.email}</span>
          </p>
          <p className="text-xs text-tertiary">
            All autonomous applications, tailored resumes/cover letters, and employer portal accounts use{" "}
            <span className="font-medium text-primary">{identity.email}</span>.
          </p>
        </section>
      )}
      <LiveDiscoverySettings />
      <RadarSourcesSettings />
    </>
  );
}