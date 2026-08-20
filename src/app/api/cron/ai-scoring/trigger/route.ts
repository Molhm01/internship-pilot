import { after, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hasGeminiApiKey } from "@/lib/gemini";
import { runAutomaticScoringSweep } from "@/lib/matching/automaticScoring";
import { hydrateMissingDescriptionsForScoring } from "@/lib/matching/jobDescriptionHydration";
import { requeueStaleFailedScores } from "@/lib/matching/recoverFailedScores";

export const runtime = "nodejs";
export const maxDuration = 300;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized scoring trigger." },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  if (!hasGeminiApiKey()) {
    return NextResponse.json(
      {
        ok: true,
        configured: false,
        accepted: false,
        skipped: "gemini_not_configured",
      },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  }

  const recentRunning = await prisma.initialAiMatchJob.findFirst({
    where: {
      state: "RUNNING",
      lockedAt: { gte: new Date(Date.now() - 7 * 60 * 1000) },
    },
    select: { id: true, lockedAt: true },
    orderBy: { lockedAt: "desc" },
  });

  if (recentRunning) {
    return NextResponse.json(
      {
        ok: true,
        configured: true,
        accepted: false,
        skipped: "already_running",
        runningSince: recentRunning.lockedAt?.toISOString() ?? null,
      },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  }

  after(async () => {
    try {
      // A job cannot receive a defensible ATS score without an actual job
      // description. Before every scoring drain, hydrate a bounded batch of
      // missing descriptions from verified employer/ATS URLs using plain HTTP
      // (serverless-safe; no Playwright dependency). Newly hydrated jobs are
      // picked up by prepareAutomaticScoringQueues in the same sweep.
      const descriptions = await hydrateMissingDescriptionsForScoring({
        maxItems: 20,
        concurrency: 4,
      });

      // Provider/database interruptions must not strand a job forever. Retry a
      // small cooled-down batch of terminal failures on each hosted sweep.
      const recovered = await requeueStaleFailedScores({ maxItems: 16 });

      const result = await runAutomaticScoringSweep({
        // With the 5-minute live-discovery cadence this can process roughly
        // 480 scores/hour at full throughput while keeping only two concurrent
        // model requests and a hard function time budget.
        maxItems: 40,
        maxRuntimeMs: 210_000,
        concurrency: 2,
      });
      console.info(JSON.stringify({
        event: "automatic-ai-scoring",
        stage: "completed",
        descriptions,
        recovered,
        ...result,
      }));
    } catch (error) {
      console.error("[automatic-ai-scoring] hosted sweep failed", {
        errorCode:
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "AUTOMATIC_SCORING_FAILED",
      });
    }
  });

  return NextResponse.json(
    { ok: true, configured: true, accepted: true },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}
