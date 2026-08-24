import { prisma } from "@/lib/db";
import { classifyEmail, type EmailClassificationResult } from "./classify";
import { loadJobMatchCandidates, matchEmailToJob, type JobMatchMethod } from "./matchJob";
import { getValidAccessToken } from "./account";
import { listRecentMessageIds, fetchMessage, type FetchedEmail } from "./client";
import { logAudit } from "@/lib/applications/audit";
import { notifyWindows } from "./notify";
import { ingestJobAlertEmail } from "@/lib/radar/jobAlertRadar";
import { processSupplementalRadarQueue } from "@/lib/sync/supplementalRadarQueue";

const STATUS_RANK: Partial<Record<string, number>> = {
  SUBMITTED: 1,
  ASSESSMENT_REQUIRED: 2,
  INTERVIEW: 3,
  OFFER: 4,
};
const CLASSIFICATION_TO_STATUS: Partial<Record<EmailClassificationResult["classification"], string>> = {
  confirmation: "SUBMITTED",
  assessment: "ASSESSMENT_REQUIRED",
  interview: "INTERVIEW",
  offer: "OFFER",
  rejection: "REJECTED",
  withdrawal: "CLOSED",
};

export type ProcessedEmailResult = {
  classification: EmailClassificationResult;
  matchedJobId: string | null;
  matchMethod: JobMatchMethod;
  statusApplied: string | null;
};

type EmailClassifier = (email: { subject: string; fromAddress: string; bodyText: string }) => Promise<EmailClassificationResult>;

/**
 * Classify and map one email for one user.
 *
 * The optional classifier dependency exists so deterministic CI can verify all
 * tracker transitions without requiring a local Ollama daemon. Production uses
 * classifyEmail by default. Tracker rank is read from UserJobState, never from
 * the deprecated shared Job.status column.
 */
export async function processEmail(
  email: { subject: string; fromAddress: string; bodyText: string },
  candidates: Awaited<ReturnType<typeof loadJobMatchCandidates>>,
  userId: string,
  classifier: EmailClassifier = classifyEmail,
): Promise<ProcessedEmailResult> {
  const classification = await classifier(email);
  const match = matchEmailToJob(email, candidates);

  let statusApplied: string | null = null;
  if (match) {
    const targetStatus = CLASSIFICATION_TO_STATUS[classification.classification];
    if (targetStatus) {
      if (targetStatus === "REJECTED" || targetStatus === "CLOSED") {
        statusApplied = targetStatus;
      } else {
        const currentState = await prisma.userJobState.findUnique({
          where: { userId_jobId: { userId, jobId: match.job.id } },
          select: { applicationStatus: true },
        });
        const currentRank = STATUS_RANK[currentState?.applicationStatus ?? ""] ?? 0;
        const targetRank = STATUS_RANK[targetStatus] ?? 0;
        if (targetRank > currentRank) statusApplied = targetStatus;
      }
    }
  }

  return {
    classification,
    matchedJobId: match?.job.id ?? null,
    matchMethod: match?.method ?? "none",
    statusApplied,
  };
}

export async function applyProcessedEmail(
  email: FetchedEmail,
  result: ProcessedEmailResult,
  userId: string,
): Promise<void> {
  await prisma.trackedEmail.create({
    data: {
      userId,
      gmailMessageId: email.gmailMessageId,
      threadId: email.threadId,
      subject: email.subject,
      fromAddress: email.fromAddress,
      snippet: email.snippet,
      receivedAt: email.receivedAt,
      classification: result.classification.classification,
      matchedJobId: result.matchedJobId,
      matchMethod: result.matchMethod,
    },
  });

  if (result.statusApplied && result.matchedJobId) {
    await prisma.userJobState.upsert({
      where: { userId_jobId: { userId, jobId: result.matchedJobId } },
      create: { userId, jobId: result.matchedJobId, applicationStatus: result.statusApplied },
      update: { applicationStatus: result.statusApplied },
    });
    await logAudit({
      userId,
      jobId: result.matchedJobId,
      actor: "gmail-tracking",
      action: "status-updated-from-email",
      detail: `Classified an email as "${result.classification.classification}" (matched via ${result.matchMethod}) — status set to ${result.statusApplied}.`,
      metadata: { classification: result.classification.classification, matchMethod: result.matchMethod },
    });
  } else if (result.matchedJobId) {
    await logAudit({
      userId,
      jobId: result.matchedJobId,
      actor: "gmail-tracking",
      action: "email-classified",
      detail: `Classified an email as "${result.classification.classification}" (matched via ${result.matchMethod}). No tracker status change applied.`,
      metadata: { classification: result.classification.classification, matchMethod: result.matchMethod },
    });
  }

  if (result.classification.classification === "assessment" && result.classification.assessment) {
    const a = result.classification.assessment;
    await prisma.assessmentInboxEntry.create({
      data: {
        userId,
        jobId: result.matchedJobId,
        sourceEmailId: email.gmailMessageId,
        company: result.classification.company ?? "Unknown company",
        jobTitle: result.classification.jobTitle,
        provider: a.provider,
        deadline: null,
        duration: a.duration,
        link: a.link,
        instructions: a.instructions,
        legitimacyNotes: result.matchedJobId
          ? "Matched to a tracked, verified job in your pipeline."
          : "Could not be matched to a job you're tracking — review carefully before trusting it.",
      },
    });
    notifyWindows(
      "New assessment detected",
      `${result.classification.company ?? "An employer"} sent an assessment${a.deadline ? ` (deadline: ${a.deadline})` : ""}. Check the Assessment Inbox.`,
    );
  }
}

async function storeJobAlertEmail(email: FetchedEmail, userId: string, provider: string): Promise<void> {
  await prisma.trackedEmail.create({
    data: {
      userId,
      gmailMessageId: email.gmailMessageId,
      threadId: email.threadId,
      subject: email.subject,
      fromAddress: email.fromAddress,
      snippet: email.snippet,
      receivedAt: email.receivedAt,
      classification: "job-alert",
      matchedJobId: null,
      matchMethod: `radar:${provider}`,
    },
  });
}

export type SyncSummary = { checked: number; classified: number; newAssessments: number; errors: number; skipped: "not_connected" | null };

/**
 * Syncs every connected mailbox, one user at a time.
 */
export async function syncAllConnectedGmailInboxes(): Promise<SyncSummary> {
  const accounts = await prisma.gmailAccount.findMany({
    where: { userId: { not: null } },
    select: { userId: true },
  });
  const total: SyncSummary = {
    checked: 0,
    classified: 0,
    newAssessments: 0,
    errors: 0,
    skipped: accounts.length === 0 ? "not_connected" : null,
  };
  for (const account of accounts) {
    if (!account.userId) continue;
    const summary = await syncGmailInbox(account.userId);
    total.checked += summary.checked;
    total.classified += summary.classified;
    total.newAssessments += summary.newAssessments;
    total.errors += summary.errors;
  }
  return total;
}

export async function syncGmailInbox(userId: string): Promise<SyncSummary> {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) return { checked: 0, classified: 0, newAssessments: 0, errors: 0, skipped: "not_connected" };

  const account = await prisma.gmailAccount.findUnique({ where: { userId } });
  const sinceEpochSeconds = account?.lastSyncAt
    ? Math.floor(account.lastSyncAt.getTime() / 1000)
    : Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);

  const summary: SyncSummary = { checked: 0, classified: 0, newAssessments: 0, errors: 0, skipped: null };
  const candidates = await loadJobMatchCandidates(userId);
  let radarEnqueued = 0;

  try {
    const ids = await listRecentMessageIds(accessToken, sinceEpochSeconds);
    for (const id of ids) {
      summary.checked++;
      try {
        const existing = await prisma.trackedEmail.findUnique({
          where: { userId_gmailMessageId: { userId, gmailMessageId: id } },
        });
        if (existing) continue;

        const email = await fetchMessage(accessToken, id);

        // LinkedIn/Handshake/Indeed/Glassdoor/ZipRecruiter are treated as
        // discovery radars, never as trusted job databases. The alert is parsed
        // into title/company signals, then the radar queue independently finds
        // the employer's official ATS posting before anything enters Discover.
        const radar = await ingestJobAlertEmail(email, userId);
        if (radar.detected && radar.provider) {
          await storeJobAlertEmail(email, userId, radar.provider);
          radarEnqueued += radar.enqueued;
          summary.classified++;
          continue;
        }

        const result = await processEmail(email, candidates, userId);
        await applyProcessedEmail(email, result, userId);
        summary.classified++;
        if (result.classification.classification === "assessment") summary.newAssessments++;
      } catch {
        summary.errors++;
      }
    }
  } catch {
    summary.errors++;
  }

  if (radarEnqueued > 0) {
    await processSupplementalRadarQueue(Math.min(20, radarEnqueued)).catch(() => undefined);
  }

  await prisma.gmailAccount.update({ where: { userId }, data: { lastSyncAt: new Date() } });
  return summary;
}
