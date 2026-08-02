import { NextResponse } from "next/server";
import {
  BulkInitialMatchError,
  getBulkInitialMatchStatus,
} from "@/lib/matching/bulkInitialMatch";

export async function GET() {
  try {
    return NextResponse.json(
      { ok: true, status: await getBulkInitialMatchStatus() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const known = error instanceof BulkInitialMatchError ? error : null;
    const errorCode = known?.code ?? "BULK_SCORE_STATUS_FAILED";
    console.error("[api/jobs/score-unscored/status] status query failed", {
      errorCode,
      operation: known?.operation ?? "queue status query",
    });
    const message = errorCode === "AI_MATCH_QUEUE_CLIENT_RESTART_REQUIRED"
      ? "The website must be restarted to load the installed AI Match queue schema."
      : errorCode === "AI_MATCH_QUEUE_MIGRATION_REQUIRED"
        ? "The AI Match queue migration is missing from the configured website database."
        : "Scoring progress is temporarily unavailable.";
    return NextResponse.json(
      {
        ok: false,
        error: errorCode,
        message,
      },
      { status: known?.status ?? 500, headers: { "cache-control": "no-store" } },
    );
  }
}
