import { NextResponse } from "next/server";
import {
  BulkInitialMatchError,
  scheduleAllUnscoredActiveJobs,
} from "@/lib/matching/bulkInitialMatch";
import { withUser } from "@/lib/auth/session";

/** Queues every job this user has no score for. Never anybody else's queue. */
export const POST = withUser(async (_request, user) => {
  try {
    const result = await scheduleAllUnscoredActiveJobs(user.id);
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
