"use client";

import { useRuntimeCapabilities } from "@/lib/runtime/capabilitiesClient";

/**
 * The truthful state for a feature that runs on the user's own computer.
 *
 * Shown instead of an action button when this Internship Pilot is hosted. The
 * distinction it draws is the one that matters: nothing is broken and nothing
 * needs retrying — the AI, the Typst compiler, and the Application Agent are
 * all on the user's machine, and a website cannot reach into it. The way in is
 * the browser extension, so that is the action offered.
 */
export default function LocalAiOfflineNotice({
  feature,
  className = "",
}: {
  /** What the user was trying to do, e.g. "Tailored document generation". */
  feature: string;
  className?: string;
}) {
  const capabilities = useRuntimeCapabilities();
  if (capabilities.runtime !== "cloud") return null;

  return (
    <div
      className={`rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-700/60 dark:bg-amber-950/30 ${className}`}
      role="status"
    >
      <p className="font-medium text-amber-900 dark:text-amber-200">Local AI offline</p>
      <p className="mt-1 text-amber-800 dark:text-amber-300">
        {feature} runs on your own computer with Ollama and the local Internship
        Agent. This website has no route to them — the browser extension is the
        bridge.
      </p>
      <a
        href="/agent-diagnostics"
        className="mt-3 inline-flex items-center rounded-md bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700"
      >
        Connect Local Agent
      </a>
    </div>
  );
}
