import { after, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hasGeminiApiKey } from "@/lib/gemini";
import { runAutomaticScoringSweep } from "@/lib/matching/automaticScoring";

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
    // This is an intentionally inactive feature, not a scheduler failure. Keep
    // the shared GitHub maintenance workflow green until the deployment owner
    // has explicitly configured a cloud model key.
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
      const result = await runAutomaticScoringSweep({
        maxItems: 24,
        maxRuntimeMs: 210_000,
        concurrency: 2,
      });
      console.info(JSON.stringify({ event: "automatic-ai-scoring", stage: "completed", ...result }));
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
