import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withUser } from "@/lib/auth/session";

export const GET = withUser(async (req, user) => {
  const url = new URL(req.url);
  const actor = url.searchParams.get("actor")?.trim() || null;
  const take = Math.min(200, Math.max(10, Number(url.searchParams.get("limit") ?? 100)));

  const where = {
    OR: [{ userId: user.id }, { userId: null }],
    ...(actor && actor !== "all" ? { actor } : {}),
  };

  const [entries, syncRuns] = await Promise.all([
    prisma.auditLogEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
    }),
    prisma.syncLog.findMany({
      orderBy: { startedAt: "desc" },
      take: 25,
    }),
  ]);

  const jobIds = Array.from(new Set(entries.map((e) => e.jobId).filter((id): id is string => Boolean(id))));
  const jobs = jobIds.length
    ? await prisma.job.findMany({
        where: { id: { in: jobIds } },
        select: { id: true, title: true, company: true },
      })
    : [];
  const jobMap = new Map(jobs.map((j) => [j.id, j]));

  return NextResponse.json({
    entries: entries.map((e) => {
      const job = e.jobId ? jobMap.get(e.jobId) : null;
      let metadata: Record<string, unknown> | null = null;
      if (e.metadata) {
        try {
          metadata = JSON.parse(e.metadata) as Record<string, unknown>;
        } catch {
          metadata = null;
        }
      }
      return {
        id: e.id,
        jobId: e.jobId,
        jobTitle: job?.title ?? null,
        company: job?.company ?? null,
        actor: e.actor,
        action: e.action,
        detail: e.detail,
        metadata,
        createdAt: e.createdAt.toISOString(),
      };
    }),
    syncRuns: syncRuns.map((s) => ({
      id: s.id,
      source: s.source,
      status: s.status,
      newJobsCount: s.newJobsCount,
      updatedJobsCount: s.updatedJobsCount,
      errorMessage: s.errorMessage,
      startedAt: s.startedAt.toISOString(),
      finishedAt: s.finishedAt?.toISOString() ?? null,
    })),
  });
});
