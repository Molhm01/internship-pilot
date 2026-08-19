import { after, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSchedulerPaused } from "@/lib/sync/schedulerState";
import { runLiveDiscoveryCycle } from "@/lib/sync/liveDiscoveryEngine";
import { hasGeminiApiKey } from "@/lib/gemini";

export const runtime = "nodejs";
export const maxDuration = 300;

const RECENT_RUNNING_WINDOW_MS = 4 * 60 * 1000;

function unauthorized() {
  return NextResponse.json(
    { error: "Unauthorized live-discovery request." },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function triggerScoringDrain(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !hasGeminiApiKey()) return;
  const url = new URL("/api/cron/ai-scoring/trigger", request.url).toString();
  after(async () => {
    try {
      await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        cache: "no-store",
      });
    } catch (error) {
      console.error("[live-discovery] could not trigger ATS scoring drain", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function handler(request: Request) {
  if (!isAuthorized(request)) return unauthorized();
  if (await isSchedulerPaused()) {
    return NextResponse.json(
      { ok: true, skipped: "scheduler_paused" },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const running = await prisma.syncLog.findFirst({
    where: {
      source: "live-discovery",
      status: "running",
      startedAt: { gte: new Date(Date.now() - RECENT_RUNNING_WINDOW_MS) },
    },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });
  if (running) {
    // Even if discovery itself is already running, keep scoring independent.
    triggerScoringDrain(request);
    return NextResponse.json(
      { ok: true, skipped: "already_running", runningSince: running.startedAt.toISOString() },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  }

  const log = await prisma.syncLog.create({
    data: { source: "live-discovery", status: "running" },
  });

  try {
    const result = await runLiveDiscoveryCycle({ atsCheckLimit: 40, queueProcessLimit: 80 });
    await prisma.syncLog.update({
      where: { id: log.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        newJobsCount: result.newJobs,
        updatedJobsCount: result.updatedJobs,
      },
    });

    // One 5-minute QStash schedule now drives both responsibilities without
    // coupling their runtimes: discovery returns normally, then a separate
    // Vercel invocation drains the durable per-user ATS scoring queue.
    triggerScoringDrain(request);

    return NextResponse.json(result, {
      headers: { "cache-control": "no-store, max-age=0" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.syncLog.update({
      where: { id: log.id },
      data: {
        status: "error",
        finishedAt: new Date(),
        errorMessage: message.slice(0, 500),
      },
    }).catch(() => undefined);
    return NextResponse.json(
      { ok: false, error: "Live internship discovery failed." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

export const GET = handler;
export const POST = handler;
