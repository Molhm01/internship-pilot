"use client";

import { useState } from "react";
import Link from "next/link";
import { signIn, signUp } from "@/lib/auth/client";
import { authErrorMessage, validateAuthInput } from "@/lib/auth/errorMessages";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase/client";

/**
 * Sign-up and sign-in share a shape, so they share a component. The only
 * differences are the extra fields and which call is made.
 *
 * The password is held in component state for exactly as long as the form is
 * open and is sent over one request. It is never put in the URL, never logged,
 * and never stored in localStorage.
 *
 * Google sits above the divider rather than below it because for a new user it
 * is the shorter path, and because burying it under a password form is how you
 * get people typing a new password they will not remember.
 */

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

export default function AuthForm({
  mode,
  googleEnabled = false,
}: {
  mode: "signup" | "login";
  /** False when the deployment has no Google credentials configured. */
  googleEnabled?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signingUp = mode === "signup";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    // Guard against a double-click / repeated submit while a request is inflight.
    if (busy) return;

    // Trim the address on both paths so a pasted leading/trailing space cannot
    // make a real account unreachable (Better Auth lowercases for lookup but
    // does not trim). Signup and login key off the exact same normalized value.
    const normalizedEmail = email.trim();

    // Client-side validation first, so obvious problems get an instant, specific
    // message instead of a round trip.
    const validationError = validateAuthInput(
      { email: normalizedEmail, password, name, confirmPassword: signingUp ? confirmPassword : undefined },
      mode,
    );
    if (validationError) {
      setError(validationError);
      return;
    }

    setBusy(true);
    try {
      const result = signingUp
        ? await signUp.email({
            email: normalizedEmail,
            password,
            // Better Auth requires a name. Falling back to the local part of
            // the address is better than storing an empty heading.
            name: name.trim() || normalizedEmail.split("@")[0]!,
          })
        : await signIn.email({ email: normalizedEmail, password });

      if (result.error) {
        // Map the server error to a clear, safe message — never a raw dump.
        setError(authErrorMessage(result.error, mode));
        return;
      }
      // A hard navigation rather than router.push: the session cookie is set on
      // this very response, and a client-side transition can render the
      // protected route before the cookie is readable, bouncing the user back
      // to /login. A full navigation guarantees the server sees the new session
      // on the first load of /dashboard.
      window.location.assign("/dashboard");
    } catch (caught) {
      // Network-level failure (no HTTP response). Keep it non-technical.
      setError(authErrorMessage({ status: 0, message: caught instanceof Error ? caught.message : undefined }, mode));
    } finally {
      setBusy(false);
    }
  }

  async function continueWithGoogle() {
    setError(null);
    setBusy(true);
    try {
      if (isSupabaseConfigured()) {
        const supabase = createBrowserClient();
        const { error: supabaseError } = await supabase.auth.signInWithOAuth({
          provider: "google",
          options: {
            redirectTo: `${window.location.origin}/auth/callback`,
          },
        });
        if (supabaseError) {
          setError(supabaseError.message);
          setBusy(false);
        }
      } else {
        // A full-page redirect to Google; the callback returns to /dashboard.
        await signIn.social({ provider: "google", callbackURL: "/dashboard" });
      }
    } catch {
      setError("Google sign-in could not be started. Try again, or use your email and password.");
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-md px-8 py-12">
      <h1 className="text-2xl font-semibold text-primary">
        {signingUp ? "Create your account" : "Log in to Internship Pilot"}
      </h1>
      <p className="mt-2 text-sm text-secondary">
        {signingUp
          ? "Your profile, résumé and applications stay yours and stay private."
          : "Welcome back."}
      </p>

      <button
        type="button"
        onClick={() => void continueWithGoogle()}
        disabled={busy}
        className="mt-8 flex w-full items-center justify-center gap-2.5 rounded-lg border border-hairline bg-surface px-4 py-2.5 text-sm font-medium text-primary hover:bg-surface-hover disabled:opacity-40"
      >
        <GoogleMark />
        Continue with Google
      </button>

      <div className="my-6 flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-hairline" />
        <span className="text-xs uppercase tracking-wider text-tertiary">or</span>
        <span className="h-px flex-1 bg-hairline" />
      </div>

      <form onSubmit={submit} className="space-y-4">
        {signingUp && (
          <label className="block">
            <span className="text-sm font-medium text-secondary">Your name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="input mt-1 w-full"
              autoComplete="name"
            />
          </label>
        )}

        <label className="block">
          <span className="text-sm font-medium text-secondary">Email address</span>
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
          <span className="text-sm font-medium text-secondary">Password</span>
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
            <span className="text-sm font-medium text-secondary">Confirm password</span>
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
          <p
            role="alert"
            className="rounded-lg border border-critical-line bg-critical-quiet px-3 py-2 text-sm text-critical"
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-dark disabled:opacity-40"
        >
          {busy ? "Working…" : signingUp ? "Create account" : "Sign in"}
        </button>
      </form>

      <p className="mt-6 text-sm text-secondary">
        {signingUp ? (
          <>
            Already have an account?{" "}
            <Link href="/login" className="text-accent-text hover:underline">
              Log in
            </Link>
          </>
        ) : (
          <>
            No account yet?{" "}
            <Link href="/signup" className="text-accent-text hover:underline">
              Create one
            </Link>
          </>
        )}
      </p>

      <p className="mt-8 text-xs leading-relaxed text-tertiary">
        This password is for Internship Pilot only. It is never used on an employer&rsquo;s website —
        those credentials stay in your browser&rsquo;s password manager or the extension&rsquo;s
        encrypted vault, and never in this database.
      </p>
    </div>
  );
}
