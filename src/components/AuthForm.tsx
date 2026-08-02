"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * Sign-up and sign-in share a shape, so they share a component. The only
 * differences are the extra fields and the endpoint.
 *
 * The password is held in component state for exactly as long as the form is
 * open and is sent over one POST. It is never put in the URL, never logged, and
 * never stored in localStorage.
 */
export default function AuthForm({ mode }: { mode: "signup" | "login" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signingUp = mode === "signup";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/auth/${signingUp ? "signup" : "login"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          signingUp ? { email, password, confirmPassword, displayName } : { email, password },
        ),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(data.error ?? "That did not work. Try again.");
        return;
      }
      router.push("/profile");
      router.refresh();
    } catch {
      setError("Could not reach Internship Pilot. Is the site still running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-md mx-auto px-8 py-16">
      <h1 className="text-2xl font-semibold">
        {signingUp ? "Create your Internship Pilot account" : "Log in to Internship Pilot"}
      </h1>
      <p className="mt-2 text-sm text-slate-600">
        This password is for Internship Pilot only. It is never used on an employer&rsquo;s website.
      </p>

      <form onSubmit={submit} className="mt-8 space-y-4">
        {signingUp && (
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Your name (optional)</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="input mt-1 w-full"
              autoComplete="name"
            />
          </label>
        )}

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Email address</span>
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="input mt-1 w-full"
            autoComplete="email"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Password</span>
          <input
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="input mt-1 w-full"
            autoComplete={signingUp ? "new-password" : "current-password"}
          />
        </label>

        {signingUp && (
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Confirm password</span>
            <input
              type="password"
              required
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className="input mt-1 w-full"
              autoComplete="new-password"
            />
          </label>
        )}

        {error && (
          <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-40"
        >
          {busy ? "Working…" : signingUp ? "Create account" : "Log in"}
        </button>
      </form>

      <p className="mt-6 text-sm text-slate-600">
        {signingUp ? (
          <>
            Already have an account? <Link href="/login" className="text-brand hover:underline">Log in</Link>
          </>
        ) : (
          <>
            No account yet? <Link href="/signup" className="text-brand hover:underline">Create one</Link>
          </>
        )}
      </p>
    </div>
  );
}
