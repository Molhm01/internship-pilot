import { after, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { syncAllConnectedGmailInboxes } from "@/lib/gmail/sync";

export const runtime = "nodejs";
export const maxDuration = 300;

const RECENT_RUNNING_WINDOW_MS = 4 * 60 * 1000;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized Gmail radar trigger." },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const recent = await prisma.syncLog.findFirst({
    where: {
      source: "gmail-radar-hosted",
      status: "running",
      startedAt: { gte: new Date(Date.now() - RECENT_RUNNING_WINDOW_MS) },
    },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });
  if (recent) {
    return NextResponse.json(
      {
        ok: true,
        accepted: false,
        skipped: "already_running",
        runningSince: recent.startedAt.toISOString(),
      },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  }

  const log = await prisma.syncLog.create({
    data: { source: "gmail-radar-hosted", status: "running" },
  });

  after(async () => {
    try {
      const result = await syncAllConnectedGmailInboxes();
      await prisma.syncLog.update({
        where: { id: log.id },
        data: {
          status: "success",
          finishedAt: new Date(),
          errorMessage: result.errors > 0
            ? `${result.errors} mailbox/message processing error(s); successful messages were retained.`
            : null,
        },
      });
      console.info(JSON.stringify({
        event: "gmail-radar-hosted",
        stage: "completed",
        checked: result.checked,
        classified: result.classified,
        newAssessments: result.newAssessments,
        errors: result.errors,
        skipped: result.skipped,
      }));
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
      console.error("[gmail-radar-hosted] sync failed", {
        errorCode: error instanceof Error ? error.name : "GMAIL_RADAR_SYNC_FAILED",
      });
    }
  });

  return NextResponse.json(
    { ok: true, accepted: true },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}
