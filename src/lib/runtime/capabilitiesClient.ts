"use client";

import { useEffect, useState } from "react";
import type { RuntimeCapabilities } from "@/lib/runtime/deployment";

export type { RuntimeCapabilities } from "@/lib/runtime/deployment";

/**
 * What this install can do, from the browser's side.
 *
 * The page needs this before it offers an action. On a hosted deployment,
 * "Generate tailored documents" and "Send to the Application Agent" are things
 * the server cannot do — the work happens on the user's own computer — and a
 * button that posts a request destined to fail is worse than one that explains
 * where the feature lives.
 *
 * Cached at module scope: the answer is a property of the deployment and does
 * not change while the tab is open.
 */
let cached: RuntimeCapabilities | null = null;
let inFlight: Promise<RuntimeCapabilities | null> | null = null;

/** Assumed while the probe is in flight, and if it fails. */
const LOCAL_DEFAULT: RuntimeCapabilities = {
  runtime: "local",
  serverSideAi: true,
  serverSideLocalAgent: true,
  serverSideDocumentGeneration: true,
  serverSideBrowserAutomation: true,
  requiresExtensionBridge: false,
};

export async function fetchRuntimeCapabilities(
  fetcher: typeof fetch = fetch,
): Promise<RuntimeCapabilities | null> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const response = await fetcher("/api/runtime", { cache: "no-store" });
      if (!response.ok) return null;
      const payload = (await response.json()) as RuntimeCapabilities;
      if (payload.runtime !== "local" && payload.runtime !== "cloud") return null;
      cached = payload;
      return payload;
    } catch {
      return null;
    }
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/**
 * Returns the deployment's capabilities, defaulting to the local answer until
 * the probe lands. Local is the safe default: it is what every existing
 * install is, and a momentarily-optimistic button is better than one that
 * flickers from disabled to enabled on every page view.
 */
export function useRuntimeCapabilities(): RuntimeCapabilities {
  const [capabilities, setCapabilities] = useState<RuntimeCapabilities>(cached ?? LOCAL_DEFAULT);

  useEffect(() => {
    let cancelled = false;
    void fetchRuntimeCapabilities().then((value) => {
      if (!cancelled && value) setCapabilities(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return capabilities;
}

export function resetRuntimeCapabilitiesForTests(): void {
  cached = null;
  inFlight = null;
}
