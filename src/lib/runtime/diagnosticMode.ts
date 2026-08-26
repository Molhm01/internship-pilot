import { NextResponse } from "next/server";

/**
 * True when this process is running as a local diagnostic session — the flag
 * scripts/test-application-agent.ts and manual local UI verification set to
 * guarantee the application-agent's Playwright browser never navigates to a
 * real employer site (see src/lib/applications/navigation.ts).
 *
 * The same flag also has to gate live external DISCOVERY, not just the
 * agent's navigation: opening /jobs mounts SyncStatusPanel, whose automatic
 * catch-up unconditionally POSTs /api/sync/run and /api/sync/fresh — real
 * outbound calls to Jobright/Intern List/public feeds/ATS boards that
 * imported ~1,000 real postings into a disposable diagnostic database during
 * one such session. LOCAL_DIAGNOSTIC_MODE is meant to make a session safe to
 * click through without any real-world side effect, so it has to block that
 * too, not only a browser navigation.
 */
export function isLocalDiagnosticMode(): boolean {
  return process.env.LOCAL_DIAGNOSTIC_MODE === "true";
}

/**
 * Standard 200 (not an error — the caller's UI treats a non-ok POST as a
 * failure banner) "nothing happened, on purpose" response for a live-
 * discovery endpoint short-circuited by diagnostic mode. Callers should
 * `return blockedInDiagnosticMode();` as the very first line of the handler,
 * before any external request is made.
 */
export function blockedInDiagnosticMode() {
  return NextResponse.json(
    {
      ok: true,
      skipped: "local_diagnostic_mode",
      message:
        "LOCAL_DIAGNOSTIC_MODE is enabled: live external discovery is disabled. Only local/seeded/mock jobs are shown.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
