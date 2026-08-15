import { prisma } from "@/lib/db";
import { detectAtsFromText } from "@/lib/ats/detect";
import { getApplicationSettings } from "./settings";
import type { AtsType } from "./types";
import { recordRunStage } from "./validation";
import { canonicalAvailability, AVAILABILITY, isActiveAvailability } from "@/lib/jobs/verificationModel";
import { isUsableResume, strategyFromTailoringStatus, jobDescriptionCompleteness, documentStrategyReason, type DocumentStrategy } from "@/lib/documents/strategy";

export const ACTIVE_APPLICATION_STATUSES = ["queued", "running", "needs_user_action"] as const;

export class ApplicationAgentError extends Error {}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

/**
 * Queue one durable run. This function deliberately contains no Playwright
 * import and performs no browser or network work, so it is safe in a route.
 */
/**
 * Queues an application run for one user against one job.
 *
 * Every function in this module now takes the owner explicitly. A run holds the
 * answers that will be typed into an employer's form, so "which run is this"
 * and "whose run is this" have to be one question — a run id alone is not
 * authority to read, resume, retry or cancel it.
 */
export async function enqueueApplication(
  jobId: string,
  userId: string,
): Promise<{ runId: string; status: string; queued: boolean }> {
  const settings = await getApplicationSettings(userId);
  if (settings.mode === "OFF") {
    throw new ApplicationAgentError("The Application Agent is turned off. Enable Fill To Submit in Settings first.");
  }

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      matchResults: { orderBy: { createdAt: "desc" }, take: 1 },
      generatedDocuments: { orderBy: { createdAt: "desc" } },
      applicationRuns: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!job) throw new ApplicationAgentError("Job not found.");
  // The agent is available from EVERY legitimate active job — officially
  // verified, source listed, OR verification pending — not only jobs matched
  // to a Greenhouse/Lever/Ashby mirror. It refuses only jobs with concrete
  // negative evidence: a confirmed closure, a destination mismatch, or a
  // security block. The worker still performs a live destination re-check
  // before filling.
  const availability = canonicalAvailability(job.verificationStatus);
  if (availability === AVAILABILITY.SECURITY_BLOCKED) {
    throw new ApplicationAgentError("This posting is security-blocked and never receives autofill or personal data.");
  }
  if (availability === AVAILABILITY.CLOSED_CONFIRMED) {
    throw new ApplicationAgentError("This posting is confirmed closed. Re-verify it first if you believe it's still open.");
  }
  if (availability === AVAILABILITY.DESTINATION_MISMATCH) {
    throw new ApplicationAgentError("This posting's destination clearly resolves to a different company/role. Re-verify before applying.");
  }
  if (!isActiveAvailability(job.verificationStatus)) {
    throw new ApplicationAgentError("This job is not in an active state. Re-verify it before applying.");
  }
  if (job.applicationRuns.some((run) => run.status === "submitted")) {
    throw new ApplicationAgentError("An application to this requisition is already recorded as submitted.");
  }
  const existingFilled = job.applicationRuns.find((run) => run.status === "filled");
  if (existingFilled) return { runId: existingFilled.id, status: existingFilled.status, queued: false };

  // A match is helpful but NOT required — the button must work even before an
  // AI score exists. Only an explicit eligibility Fail blocks queuing.
  const latestMatch = job.matchResults[0];
  if (latestMatch && latestMatch.eligibility === "Fail") {
    throw new ApplicationAgentError("The AI match marked this job an explicit eligibility Fail; applying isn't recommended.");
  }
  // Resolve the best destination: prefer the confirmed official apply URL,
  // then the stored url/job page, then the source listing's apply link (the
  // worker resolves its redirects live before filling).
  const officialApplyUrl = job.officialApplyUrl ?? job.url ?? job.officialJobUrl ?? job.sourceUrl;
  if (!officialApplyUrl) throw new ApplicationAgentError("This job has no usable application or source URL to open.");
  try {
    const parsed = new URL(officialApplyUrl);
    const localMock = job.source === "application-worker-test" && parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !localMock) throw new Error("not HTTPS");
  } catch {
    throw new ApplicationAgentError(`Invalid required job field officialApplyUrl: expected a valid HTTPS URL; received ${JSON.stringify(officialApplyUrl)}.`);
  }
  if (job.officialApplyUrl !== officialApplyUrl) await prisma.job.update({ where: { id: job.id }, data: { officialApplyUrl } });

  // Document strategy is separate from autofill eligibility. ANY QA-passed,
  // identity-verified resume for this job is usable — including a
  // master-resume fallback generated when the description was incomplete. Only
  // the total ABSENCE of an approved resume (NO_APPROVED_DOCUMENT) blocks the
  // run; a missing/partial job description never does.
  const usableResumes = job.generatedDocuments.filter((document) => isUsableResume(document));
  const resume = usableResumes.find((d) => strategyFromTailoringStatus(d.tailoringStatus) === "TAILORED")
    ?? usableResumes.find((d) => strategyFromTailoringStatus(d.tailoringStatus) === "PARTIAL_TAILORING")
    ?? usableResumes[0];
  const completeness = jobDescriptionCompleteness(job);
  let documentStrategy: DocumentStrategy;
  if (!resume) {
    documentStrategy = "NO_APPROVED_DOCUMENT";
    throw new ApplicationAgentError(documentStrategyReason(documentStrategy, completeness));
  }
  // Reusing an existing approved doc → EXISTING_APPROVED_DOCUMENT; otherwise the
  // strategy reflects how tailored that resume is.
  documentStrategy = "EXISTING_APPROVED_DOCUMENT";
  const strategyReason = `${documentStrategyReason("EXISTING_APPROVED_DOCUMENT", completeness)} (${strategyFromTailoringStatus(resume.tailoringStatus)})`;
  const coverLetter = job.generatedDocuments.find((document) => document.type === "coverLetter" && document.qaStatus === "pass" && document.identityVerified);

  // Repair legacy duplicates before assigning the unique active key.
  const active = job.applicationRuns.filter((run) =>
    ACTIVE_APPLICATION_STATUSES.includes(run.status as (typeof ACTIVE_APPLICATION_STATUSES)[number]),
  );
  if (active.length) {
    const canonical = [...active].sort(
      (a, b) => Number(Boolean(b.stoppedFieldLabel)) - Number(Boolean(a.stoppedFieldLabel)) || a.createdAt.getTime() - b.createdAt.getTime(),
    )[0];
    const duplicateIds = active.filter((run) => run.id !== canonical.id).map((run) => run.id);
    if (duplicateIds.length) {
      await prisma.applicationRun.updateMany({
        where: { id: { in: duplicateIds } },
        data: { status: "superseded", activeKey: null, finishedAt: new Date(), currentStep: "Superseded duplicate run" },
      });
    }
    try {
      const repaired = await prisma.applicationRun.update({ where: { id: canonical.id }, data: { activeKey: jobId } });
      return { runId: repaired.id, status: repaired.status, queued: false };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const winner = await prisma.applicationRun.findUnique({ where: { activeKey: jobId } });
      if (winner) return { runId: winner.id, status: winner.status, queued: false };
      throw error;
    }
  }

  const atsType = detectAtsFromText(officialApplyUrl).atsType as AtsType;
  try {
    const run = await prisma.applicationRun.create({
      data: {
        activeKey: jobId,
        jobId,
        // Production is intentionally locked to Fill To Submit. The worker
        // never receives permission to click a final Submit control.
        mode: "fill_to_submit",
        atsType,
        status: "queued",
        currentStep: "QUEUED",
        stageHistory: JSON.stringify([{ stage: "QUEUED", at: new Date().toISOString(), detail: `Validated queue request for ${officialApplyUrl}.` }]),
        resumeDocumentId: resume.id,
        coverLetterDocumentId: coverLetter?.id ?? null,
        documentStrategy,
        documentStrategyReason: strategyReason,
        jobDescriptionCompleteness: completeness,
        matchScoreAtRun: latestMatch?.score ?? null,
      },
    });
    await prisma.job.update({ where: { id: jobId }, data: { status: "APPLYING" } });
    await prisma.auditLogEntry.create({
      data: {
        jobId,
        actor: "application-agent",
        action: "application-run-queued",
        detail: `Queued Fill To Submit run for "${job.title}" at ${job.company}.`,
        metadata: JSON.stringify({ runId: run.id, atsType }),
      },
    });
    return { runId: run.id, status: run.status, queued: true };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const winner = await prisma.applicationRun.findUnique({ where: { activeKey: jobId } });
    if (!winner) throw error;
    return { runId: winner.id, status: winner.status, queued: false };
  }
}

export async function queueAnsweredRun(
  runId: string,
  userId: string,
): Promise<{ runId: string; status: string }> {
  const run = await prisma.applicationRun.findFirst({ where: { id: runId, userId } });
  if (!run) {
    throw new ApplicationAgentError("This run has no pending question to resume.");
  }
  if (run.status === "queued" || run.status === "running") {
    return { runId: run.id, status: run.status };
  }
  if (run.status !== "needs_user_action") {
    throw new ApplicationAgentError("This run has no pending question to resume.");
  }
  const resumed = await prisma.applicationRun.updateMany({
    where: { id: runId, status: "needs_user_action", activeKey: run.jobId },
    data: {
      activeKey: run.jobId,
      status: "queued",
      currentStep: "QUEUED",
      needsUserActionReason: null,
      finishedAt: null,
    },
  });
  if (resumed.count !== 1) {
    const current = await prisma.applicationRun.findUnique({ where: { id: runId } });
    if (current && (current.status === "queued" || current.status === "running")) {
      return { runId: current.id, status: current.status };
    }
    throw new ApplicationAgentError("This paused run changed state before it could be resumed.");
  }
  const detail = run.needsUserActionReason === "captcha"
    ? "User requested same-run resume after completing the CAPTCHA."
    : run.needsUserActionReason === "mfa"
      ? "User requested same-run resume after completing MFA."
      : run.needsUserActionReason === "login_required"
        ? "User requested same-run resume after logging in."
        : "Approved answer saved; resuming the same run.";
  await recordRunStage(runId, "QUEUED", detail);
  return { runId, status: "queued" };
}

export async function retryFailedRun(
  runId: string,
  userId: string,
): Promise<{ runId: string; status: string }> {
  const run = await prisma.applicationRun.findFirst({
    where: { id: runId, userId },
    include: { job: { include: { applicationRuns: { where: { userId } } } } },
  });
  if (!run) {
    throw new ApplicationAgentError("Only a failed ApplicationRun can be retried with this action.");
  }
  if (run.status === "queued" || run.status === "running") return { runId: run.id, status: run.status };
  if (run.status !== "failed") throw new ApplicationAgentError("Only a failed ApplicationRun can be retried with this action.");
  if (run.job.applicationRuns.some((candidate) =>
    candidate.id !== run.id
    && ACTIVE_APPLICATION_STATUSES.includes(candidate.status as (typeof ACTIVE_APPLICATION_STATUSES)[number]),
  )) {
    throw new ApplicationAgentError("This job already has a queued or active run. The failed run was not duplicated.");
  }
  if (run.job.applicationRuns.some((candidate) => candidate.id !== run.id && candidate.status === "submitted")) {
    throw new ApplicationAgentError("This requisition is already recorded as submitted.");
  }

  try {
    let history: Array<Record<string, unknown>> = [];
    try {
      if (run.attemptHistory) history = JSON.parse(run.attemptHistory);
    } catch {
      history = [];
    }
    history.push({
      attemptNumber: run.attemptNumber,
      status: run.status,
      error: run.errorLog,
      errorCode: run.errorCode,
      validationPath: run.validationPath,
      currentStep: run.currentStep,
      stageHistory: run.stageHistory,
      finishedAt: run.finishedAt ?? new Date(),
    });

    const nextAttempt = run.attemptNumber + 1;

    const retry = await prisma.applicationRun.updateMany({
      where: { id: run.id, status: "failed", activeKey: null },
      data: {
        activeKey: run.jobId,
        status: "queued",
        currentStep: "QUEUED",
        attemptNumber: nextAttempt,
        attemptHistory: JSON.stringify(history),
        needsUserActionReason: null,
        stoppedFieldLabel: null,
        stoppedFieldType: null,
        stoppedFieldOptions: null,
        stoppedFieldStep: null,
        stoppedFieldContext: null,
        errorCode: null,
        validationPath: null,
        errorLog: null,
        finishedAt: null,
      },
    });
    if (retry.count !== 1) {
      const current = await prisma.applicationRun.findUnique({ where: { id: run.id } });
      if (current && (current.status === "queued" || current.status === "running")) {
        return { runId: current.id, status: current.status };
      }
      throw new ApplicationAgentError("This failed run changed state before it could be queued.");
    }
    await recordRunStage(run.id, "QUEUED", `Retry attempt #${nextAttempt} requested; transients cleared for fresh DOM scan.`);
    await prisma.job.update({ where: { id: run.jobId }, data: { status: "APPLYING" } });
    await prisma.auditLogEntry.create({
      data: {
        jobId: run.jobId,
        actor: "application-agent",
        action: "application-run-retried",
        detail: "Retried the existing failed ApplicationRun without creating a new run.",
        metadata: JSON.stringify({ runId: run.id }),
      },
    });
    return { runId: run.id, status: "queued" };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ApplicationAgentError("This job already has a queued or active run. The failed run was not duplicated.");
    }
    throw error;
  }
}
