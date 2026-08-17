import { after, NextResponse } from "next/server";
import {
  BulkInitialMatchError,
  scheduleAllUnscoredActiveJobs,
} from "@/lib/matching/bulkInitialMatch";
import { runAutomaticScoringSweep } from "@/lib/matching/automaticScoring";
import { hasGeminiApiKey } from "@/lib/gemini";
import { isCloudRuntime } from "@/lib/runtime/deployment";
import { withUser } from "@/lib/auth/session";

/**
 * Emergency/manual fallback. Normal production operation is scheduled, but if
 * the user presses the button this route now starts real processing instead of
 * merely leaving rows in PENDING.
 */
export const POST = withUser(async (_request, user) => {
  try {
    const result = await scheduleAllUnscoredActiveJobs(user.id);

    if (isCloudRuntime() && hasGeminiApiKey()) {
      after(async () => {
        try {
          await runAutomaticScoringSweep({ maxItems: 12, maxRuntimeMs: 120_000, concurrency: 2 });
        } catch (error) {
          console.error("[api/jobs/score-unscored] background worker failed", {
            errorCode:
              error && typeof error === "object" && "code" in error
                ? String((error as { code: unknown }).code)
                : "AUTOMATIC_SCORING_FAILED",
          });
        }
      });
    }

    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const known = error instanceof BulkInitialMatchError ? error : null;
    const errorCode = known?.code ?? "BULK_SCORE_SCHEDULING_FAILED";
    console.error("[api/jobs/score-unscored] scheduling failed", {
      errorCode,
      operation: known?.operation ?? "bulk scheduling",
    });
    const message = errorCode === "AI_MATCH_QUEUE_CLIENT_RESTART_REQUIRED"
      ? "The website must be restarted to load the installed AI Match queue schema."
      : errorCode === "AI_MATCH_QUEUE_MIGRATION_REQUIRED"
        ? "The AI Match queue migration is missing from the configured website database."
        : process.env.NODE_ENV === "development"
          ? `Queue scheduling failed during ${known?.operation ?? "bulk scheduling"} (${errorCode}).`
          : "Unscored jobs could not be queued. Please try again.";
    return NextResponse.json(
      {
        ok: false,
        error: errorCode,
        message,
      },
      { status: known?.status ?? 500, headers: { "cache-control": "no-store" } },
    );
  }
});
