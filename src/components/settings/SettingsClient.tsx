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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void authClient
      .getSession()
      .then((result) => {
        if (cancelled) return;
        const user = result.data?.user;
        if (!user) {
          window.location.replace("/login?next=/settings");
          return;
        }
        setIdentity({ name: user.name ?? "", email: user.email });
      })
      .catch(() => {
        if (!cancelled) setError("Could not load your account session. Reload Settings to try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

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
      <AccountSettings
        name={identity.name}
        email={identity.email}
        googleEnabled={googleEnabled}
      />
      <LiveDiscoverySettings />
    </>
  );
}
