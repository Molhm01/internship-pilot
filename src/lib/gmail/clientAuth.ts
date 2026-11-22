"use client";

import { useEffect, useState } from "react";
import { getApp, getApps, initializeApp, registerVersion, type FirebaseApp } from "@firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  type Auth,
  type User,
} from "@firebase/auth";
import firebaseConfig from "../../../firebase-applet-config.json";

// Keep the app wrapper's SDK registration used by Firebase Auth.
registerVersion("firebase", "13.4.0", "app");

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"] as const;

export interface GmailAuthSnapshot {
  connected: boolean;
  accessToken: string | null;
  email: string | null;
  displayName: string | null;
  ready: boolean;
}

let cachedApp: FirebaseApp | null = null;
let cachedAuth: Auth | null = null;
let isSigningIn = false;
// Strictly in-memory OAuth access token cache (never written to localStorage/sessionStorage).
let cachedAccessToken: string | null = null;
let cachedUser: User | null = null;
let authListenerInitialized = false;
let authReady = false;

const listeners = new Set<(snapshot: GmailAuthSnapshot) => void>();

function getFirebaseAuth(): Auth {
  if (!cachedApp) {
    cachedApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  }
  if (!cachedAuth) {
    cachedAuth = getAuth(cachedApp);
  }
  return cachedAuth;
}

function buildProvider(loginHint?: string): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  for (const scope of GMAIL_SCOPES) {
    provider.addScope(scope);
  }
  provider.setCustomParameters({
    prompt: "select_account",
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return provider;
}

export function getGmailAuthSnapshot(): GmailAuthSnapshot {
  return {
    connected: Boolean(cachedAccessToken && cachedUser),
    accessToken: cachedAccessToken,
    email: cachedUser?.email ?? null,
    displayName: cachedUser?.displayName ?? null,
    ready: authReady,
  };
}

function emitSnapshot() {
  const snap = getGmailAuthSnapshot();
  for (const listener of listeners) {
    listener(snap);
  }
}

export function initGmailAuth(): void {
  if (typeof window === "undefined" || authListenerInitialized) return;
  authListenerInitialized = true;
  const auth = getFirebaseAuth();
  onAuthStateChanged(auth, (user) => {
    authReady = true;
    if (user) {
      cachedUser = user;
      if (!cachedAccessToken && !isSigningIn) {
        // Firebase restores the user session across reloads, but the Workspace OAuth
        // access token is intentionally in-memory only; require re-click when empty.
        cachedAccessToken = null;
      }
    } else {
      cachedUser = null;
      cachedAccessToken = null;
    }
    emitSnapshot();
  });
}

export function subscribeGmailAuth(listener: (snapshot: GmailAuthSnapshot) => void): () => void {
  initGmailAuth();
  listeners.add(listener);
  listener(getGmailAuthSnapshot());
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Must be invoked directly from a user click handler (e.g., "Sign in with Google").
 */
export async function signInWithGoogleGmail(
  loginHint = "mjalasri1@gmail.com",
): Promise<{ user: User; accessToken: string }> {
  const auth = getFirebaseAuth();
  const provider = buildProvider(loginHint);
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error("Google sign-in completed, but no Gmail access token was returned. Please try again.");
    }
    cachedUser = result.user;
    cachedAccessToken = credential.accessToken;
    authReady = true;
    emitSnapshot();
    return { user: result.user, accessToken: cachedAccessToken };
  } finally {
    isSigningIn = false;
  }
}

export function getGmailAccessToken(): string | null {
  return cachedAccessToken;
}

export async function signOutGmail(): Promise<void> {
  const auth = getFirebaseAuth();
  await auth.signOut();
  cachedUser = null;
  cachedAccessToken = null;
  emitSnapshot();
}

export function useGmailAuth(): GmailAuthSnapshot {
  const [snapshot, setSnapshot] = useState<GmailAuthSnapshot>(() => getGmailAuthSnapshot());

  useEffect(() => {
    return subscribeGmailAuth(setSnapshot);
  }, []);

  return snapshot;
}
