import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withUser } from "@/lib/auth/session";
import { readJobAlertProviderStatus } from "@/lib/radar/jobAlertRadar";
import { getSupplementalRadarHealthFast } from "@/lib/sync/radarQueueHealth";

export const runtime = "nodejs";

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export const GET = withUser(async (_request, user) => {
  const [
    gmail,
    providers,
    supplemental,
    jobrightCursor,
    directCursor,
    lastLiveRun,
  ] = await Promise.all([
    prisma.gmailAccount.findUnique({
      where: { userId: user.id },
      select: { emailAddress: true, lastSyncAt: true, connectedAt: true },
    }),
    readJobAlertProviderStatus(user.id),
    // Keep queue counting in Postgres. The old implementation transferred and
    // JSON-parsed up to 10,000 AppSetting rows on every Settings refresh.
    getSupplementalRadarHealthFast(),
    prisma.appSetting.findUnique({ where: { key: "liveDiscovery:cursor:jobright-fresh" } }),
    prisma.appSetting.findUnique({ where: { key: "liveDiscovery:cursor:direct-radar" } }),
    prisma.syncLog.findFirst({
      where: { source: "live-discovery", status: "success" },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true, newJobsCount: true, updatedJobsCount: true },
    }),
  ]);

  return NextResponse.json(
    {
      ok: true,
      lastLiveRun: lastLiveRun
        ? {
            finishedAt: lastLiveRun.finishedAt?.toISOString() ?? null,
            newJobs: lastLiveRun.newJobsCount,
            updatedJobs: lastLiveRun.updatedJobsCount,
          }
        : null,
      sources: {
        jobright: parseJson<Record<string, unknown>>(jobrightCursor?.value),
        internList: supplemental.internListCursor,
        directPublicFeeds: parseJson<Record<string, unknown>>(directCursor?.value),
        gmail: {
          connected: Boolean(gmail),
          emailAddress: gmail?.emailAddress ?? null,
          lastSyncAt: gmail?.lastSyncAt?.toISOString() ?? null,
          providers,
        },
      },
      queue: {
        pending: supplemental.pending,
        retry: supplemental.retry,
        resolved: supplemental.resolved,
        abandoned: supplemental.abandoned,
        bySource: supplemental.bySource,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
});
