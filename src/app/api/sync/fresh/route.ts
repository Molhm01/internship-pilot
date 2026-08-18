import { guardSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runJobrightFreshDiscovery } from "@/lib/sync/jobrightFreshDiscovery";

export const runtime = "nodejs";
export const maxDuration = 120;

const DAY_MS = 24 * 60 * 60 * 1000;
const FRESH_24H_TARGET = 25;
const FRESH_72H_TARGET = 75;
const RECENT_RUNNING_WINDOW_MS = 4 * 60 * 1000;

export async function POST() {
  const denied = await guardSession();
  if (denied) return denied;

  const running = await prisma.syncLog.findFirst({
    where: {
      source: "fresh-discovery",
      status: "running",
      startedAt: { gte: new Date(Date.now() - RECENT_RUNNING_WINDOW_MS) },
    },
    select: { startedAt: true },
    orderBy: { startedAt: "desc" },
  });
  if (running) {
    return NextResponse.json(
      { ok: true, skipped: "already_running", runningSince: running.startedAt.toISOString() },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  }

  const log = await prisma.syncLog.create({
    data: { source: "fresh-discovery", status: "running" },
  });

  try {
    const freshDiscovery = await runJobrightFreshDiscovery(200);
    const now = Date.now();
    const [active, fresh24h, fresh72h] = await Promise.all([
      prisma.job.count({ where: { activeFeed: true } }),
      prisma.job.count({
        where: { activeFeed: true, sourcePostedAt: { gte: new Date(now - DAY_MS) } },
      }),
      prisma.job.count({
        where: { activeFeed: true, sourcePostedAt: { gte: new Date(now - 3 * DAY_MS) } },
      }),
    ]);

    await prisma.syncLog.update({
      where: { id: log.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        newJobsCount: freshDiscovery.newCount,
        updatedJobsCount: freshDiscovery.updatedCount,
      },
    });

    return NextResponse.json(
      {
        ok: true,
        active,
        fresh24h,
        fresh72h,
        fresh24hTarget: FRESH_24H_TARGET,
        fresh72hTarget: FRESH_72H_TARGET,
        freshnessTargetReached: fresh24h >= FRESH_24H_TARGET && fresh72h >= FRESH_72H_TARGET,
        freshDiscovery,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: "error", finishedAt: new Date(), errorMessage: message.slice(0, 500) },
    }).catch(() => undefined);
    return NextResponse.json({ error: "Fresh internship sync failed." }, { status: 500 });
  }
}
