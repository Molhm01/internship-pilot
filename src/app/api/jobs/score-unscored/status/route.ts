import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  BulkInitialMatchError,
  getBulkInitialMatchStatus,
} from "@/lib/matching/bulkInitialMatch";
import { withUser } from "@/lib/auth/session";

async function fallbackStatus(userId: string) {
  const [active, completed] = await Promise.all([
    prisma.job.count({ where: { activeFeed: true } }),
    prisma.job.count({
      where: {
        activeFeed: true,
        userStates: {
          some: {
            userId,
            matchScore: { gte: 0, lte: 100 },
          },
        },
      },
    }),
  ]);

  return {
    totalUnscored: Math.max(0, active - completed),
    queued: 0,
    running: 0,
    completed,
    failed: 0,
  };
}

/** Scoring progress for the signed-in user's own queue. */
export const GET = withUser(async (_request, user) => {
  try {
    return NextResponse.json(
      { ok: true, status: await getBulkInitialMatchStatus(user.id) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const known = error instanceof BulkInitialMatchError ? error : null;
    const errorCode = known?.code ?? "BULK_SCORE_STATUS_FAILED";
    console.error("[api/jobs/score-unscored/status] status query failed", {
      errorCode,
      operation: known?.operation ?? "queue status query",
    });

    // Missing schema/client support is actionable and must remain explicit.
    // Any other telemetry failure is not a scoring failure: fall back to the
    // two cheap per-user counts the Discover page actually needs instead of
    // turning a temporary queue-count problem into a red product error.
    if (![
      "AI_MATCH_QUEUE_CLIENT_RESTART_REQUIRED",
      "AI_MATCH_QUEUE_MIGRATION_REQUIRED",
    ].includes(errorCode)) {
      try {
        return NextResponse.json(
          {
            ok: true,
            degraded: true,
            status: await fallbackStatus(user.id),
          },
          { headers: { "cache-control": "no-store" } },
        );
      } catch {
        // If even the base job counts fail, return the original diagnostic.
      }
    }

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
});
