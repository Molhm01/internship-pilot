import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withUser } from "@/lib/auth/session";
import {
  getAutopilotConfig,
  getAutopilotLastSummary,
  getPortalCredentials,
} from "@/lib/applications/autonomousRunner";

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const GET = withUser(async (_req, user) => {
  const [runs, config, lastSummary, portalCredentials, gmailCount, activeJobCount, scoredJobCount] = await Promise.all([
    prisma.applicationRun.findMany({
      where: { userId: user.id },
      include: {
        job: {
          select: {
            id: true,
            title: true,
            company: true,
            location: true,
            atsType: true,
            officialApplyUrl: true,
            url: true,
            sourceUrl: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    getAutopilotConfig(user.id),
    getAutopilotLastSummary(user.id),
    getPortalCredentials(user.id),
    prisma.gmailAccount.count({ where: { userId: user.id } }),
    prisma.job.count({ where: { activeFeed: true } }),
    prisma.userJobState.count({ where: { userId: user.id, matchScore: { not: null } } }),
  ]);

  const formatted = runs.map((run) => ({
    id: run.id,
    jobId: run.jobId,
    jobTitle: run.job.title,
    company: run.job.company,
    location: run.job.location,
    applyUrl: run.job.officialApplyUrl ?? run.job.url ?? run.job.sourceUrl,
    atsType: run.atsType,
    mode: run.mode,
    status: run.status,
    currentStep: run.currentStep,
    matchScoreAtRun: run.matchScoreAtRun,
    documentStrategy: run.documentStrategy,
    documentStrategyReason: run.documentStrategyReason,
    resumeDocumentId: run.resumeDocumentId,
    coverLetterDocumentId: run.coverLetterDocumentId,
    confirmationNumber: run.confirmationNumber,
    confirmationUrl: run.confirmationUrl,
    screenshotPath: run.screenshotPath,
    needsUserActionReason: run.needsUserActionReason,
    stoppedFieldLabel: run.stoppedFieldLabel,
    stoppedFieldType: run.stoppedFieldType,
    stoppedFieldOptions: safeJson<string[]>(run.stoppedFieldOptions, []),
    stoppedFieldContext: safeJson<Record<string, unknown> | null>(run.stoppedFieldContext, null),
    answers: safeJson<Record<string, string>>(run.answers, {}),
    stageHistory: safeJson<Array<{ stage: string; at: string; detail?: string }>>(run.stageHistory, []),
    errorLog: run.errorLog,
    errorCode: run.errorCode,
    attemptNumber: run.attemptNumber,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  }));

  const submitted = formatted.filter((r) => r.status === "submitted").length;
  const filled = formatted.filter((r) => r.status === "filled").length;
  const needsUserAction = 0;
  const failed = formatted.filter((r) => r.status === "failed").length;
  const running = formatted.filter((r) => r.status === "running" || r.status === "queued").length;

  return NextResponse.json({
    runs: formatted,
    metrics: {
      activeJobs: activeJobCount,
      scoredJobs: scoredJobCount,
      totalRuns: formatted.length,
      submitted,
      filled,
      needsUserAction,
      failed,
      running,
    },
    autopilotConfig: config,
    portalCredentials,
    gmailConnected: gmailCount > 0,
    lastSummary,
  });
});
