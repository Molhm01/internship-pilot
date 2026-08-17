import { after } from "next/server";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 300;

function unauthorized() {
  return NextResponse.json(
    { error: "Unauthorized ingestion trigger." },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Fast trigger used by an external scheduler.
 *
 * Vercel Hobby cron itself can only run once per day, so GitHub Actions calls
 * this route every 30 minutes. The HTTP request returns immediately and the
 * actual employer sweep continues inside Vercel through Next.js `after()`.
 * That keeps GitHub runner usage tiny while preserving Vercel's five-minute
 * function window for the real ingestion work.
 */
export async function POST(request: Request) {
  if (!isAuthorized(request)) return unauthorized();

  // Do not stack a second sweep on top of one that is already legitimately
  // running. A row older than seven minutes is considered stale because the
  // Vercel function itself cannot live that long on Hobby.
  const recentRunning = await prisma.syncLog.findFirst({
    where: {
      source: "employer-ats",
      status: "running",
      startedAt: { gte: new Date(Date.now() - 7 * 60 * 1000) },
    },
    select: { id: true, startedAt: true },
    orderBy: { startedAt: "desc" },
  });

  if (recentRunning) {
    return NextResponse.json(
      {
        ok: true,
        accepted: false,
        skipped: "already_running",
        runningSince: recentRunning.startedAt.toISOString(),
      },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  }

  const secret = process.env.CRON_SECRET!;
  const ingestionUrl = new URL("/api/cron/job-ingestion", request.url);

  after(async () => {
    try {
      const response = await fetch(ingestionUrl, {
        method: "GET",
        headers: { authorization: `Bearer ${secret}` },
        cache: "no-store",
      });
      const body = await response.text();
      if (!response.ok) {
        console.error(
          `[live-ingestion] employer sweep failed (${response.status}): ${body.slice(0, 1000)}`,
        );
      } else {
        console.info(`[live-ingestion] employer sweep completed: ${body.slice(0, 1000)}`);
      }
    } catch (error) {
      console.error("[live-ingestion] employer sweep trigger failed", error);
    }
  });

  return NextResponse.json(
    { ok: true, accepted: true },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}
