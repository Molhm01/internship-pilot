import { prisma } from "@/lib/db";
import { recheckOfficialUrl, verifyJob } from "@/lib/sync/verify";
import { logAudit } from "@/lib/applications/audit";
import { checkJobForFraud } from "@/lib/sync/fraudCheck";
import { recomputeJobActiveFeed } from "@/lib/jobs/activeFeed";
import { recordVerificationAttempt } from "@/lib/jobs/verificationAttempt";
import {
  destinationPersistenceData,
  resolveOfficialJobDestination,
} from "@/lib/applications/officialDestination";

const PENDING_BATCH_SIZE = 5;
const RECHECK_BATCH_SIZE = 3;
const RECHECK_STALENESS_MS = 20 * 60 * 60 * 1000; // ~20 hours

export type QueueSummary = {
  verified: number;
  needsReview: number;
  closed: number;
  quarantined: number;
  scored: number;
  errors: number;
};

// Exported so tests can drive verification + automatic scoring for a single
// known job id without touching whatever else happens to be Pending.
export async function verifyPendingJob(job: {
  id: string;
  title: string;
  company: string;
  location: string | null;
  workplaceType: string | null;
}): Promise<{ outcome: string; scored: boolean }> {
  const result = await verifyJob({
    title: job.title,
    company: job.company,
    location: job.location,
    workModel: job.workplaceType,
  });
  const stored = await prisma.job.findUnique({ where: { id: job.id } });
  const company = await prisma.company.findFirst({
    where: { name: { equals: job.company } },
    select: { careersUrl: true },
  });
  const destination = await resolveOfficialJobDestination({
    ...(stored ?? {}),
    verificationStatus: result.status,
    officialApplicationUrl: result.officialApplyUrl ?? stored?.officialApplicationUrl,
    officialApplyUrl: result.officialApplyUrl ?? stored?.officialApplyUrl,
    officialJobUrl: result.officialApplyUrl ?? stored?.officialJobUrl,
    url: result.officialApplyUrl ?? stored?.url,
    employerCareerUrl: company?.careersUrl,
  });
  const destinationData = destinationPersistenceData(destination);

  await prisma.job.update({
    where: { id: job.id },
    data: {
      verificationStatus: result.status,
      reasonCode: result.reasonCode,
      verificationReason: result.reason,
      verificationMethod: result.verificationMethod ?? null,
      officialEmployerDomain: result.officialEmployerDomain ?? null,
      evidence: result.evidence ? JSON.stringify(result.evidence) : null,
      lastVerifiedAt: new Date(),
      discoverySource: "intern-list",
      atsType: result.verificationMethod?.split("-")[0] ?? null,
      atsTenant: result.atsTenant ?? null,
      ...destinationData,
      redirectChain: result.redirectChain ? JSON.stringify(result.redirectChain) : null,
      httpStatusAtVerification: result.httpStatusAtVerification ?? null,
      ...(result.requisitionId ? { requisitionId: result.requisitionId } : {}),
      ...(result.officialDescription ? { description: result.officialDescription } : {}),
    },
  });
  // Append-only attempt history — never grows the displayed reason string.
  await recordVerificationAttempt({
    jobId: job.id,
    status: result.status,
    reasonCode: result.reasonCode,
    message: result.reason,
    httpStatus: result.httpStatusAtVerification ?? null,
  });
  // Verification changed the destination state; refresh visibility centrally.
  await recomputeJobActiveFeed(job.id);

  await logAudit({
    jobId: job.id,
    actor: "verification",
    action: "verification-result",
    detail: `${result.status}: ${result.reason}`,
    metadata: { verificationMethod: result.verificationMethod, evidence: result.evidence },
  });

  // Fraud protection: scan the official description text (fraud signals
  // showing up on the aggregator's copy alone isn't enough — only the
  // employer's own official text is trusted here) before ever treating
  // this job as something to show/score/apply to.
  if (result.officialDescription) {
    const signals = await checkJobForFraud(job.id, [result.officialDescription]);
    if (signals.length > 0) {
      await logAudit({
        jobId: job.id,
        actor: "verification",
        action: "security-quarantine",
        detail: `Moved to Security Quarantine: ${signals.map((s) => s.reason).join(", ")}`,
      });
      await recomputeJobActiveFeed(job.id);
      return { outcome: "SecurityQuarantine", scored: false };
    }
  }

  return { outcome: result.status, scored: false };
}

export async function runQueueBatch(): Promise<QueueSummary> {
  const summary: QueueSummary = { verified: 0, needsReview: 0, closed: 0, quarantined: 0, scored: 0, errors: 0 };

  const pending = await prisma.job.findMany({
    where: { verificationStatus: "Pending" },
    orderBy: { firstSeenAt: "asc" },
    take: PENDING_BATCH_SIZE,
  });

  for (const job of pending) {
    try {
      const { outcome, scored } = await verifyPendingJob(job);
      if (outcome === "VERIFIED_OFFICIAL_AT_LAST_CHECK") summary.verified++;
      else if (outcome === "ACTIVE_SOURCE_LISTED" || outcome === "VERIFICATION_PENDING") summary.needsReview++;
      else if (outcome === "Closed" || outcome === "DESTINATION_MISMATCH") summary.closed++;
      else if (outcome === "SecurityQuarantine") summary.quarantined++;
      if (scored) summary.scored++;
    } catch {
      summary.errors++;
    }
  }

  // Ambient re-check of aging VERIFIED_OFFICIAL_AT_LAST_CHECK jobs so stale postings get
  // caught as Closed even if the user never opens them.
  const staleVerified = await prisma.job.findMany({
    where: {
      verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
      url: { not: null },
      lastVerifiedAt: { lt: new Date(Date.now() - RECHECK_STALENESS_MS) },
    },
    orderBy: { lastVerifiedAt: "asc" },
    take: RECHECK_BATCH_SIZE,
  });

  for (const job of staleVerified) {
    try {
      const { availability, reasonCode, reason, redirectChain, httpStatus } = await recheckOfficialUrl(job.url as string);
      // Only a genuine closure (404/410) moves the job to Closed. A transient
      // failure holds the job as-is (still active) — never falsely closed.
      const closing = availability === "closed";
      const destination = await resolveOfficialJobDestination(job);
      await prisma.job.update({
        where: { id: job.id },
        data: {
          lastVerifiedAt: new Date(),
          ...destinationPersistenceData(destination),
          redirectChain: JSON.stringify(redirectChain),
          httpStatusAtVerification: httpStatus,
          ...(closing ? { verificationStatus: "Closed", reasonCode, verificationReason: reason } : {}),
        },
      });
      await recordVerificationAttempt({ jobId: job.id, status: closing ? "Closed" : job.verificationStatus, reasonCode, message: reason, httpStatus });
      if (closing) {
        // A now-dead destination drops out of the Active feed.
        await recomputeJobActiveFeed(job.id);
        summary.closed++;
      }
    } catch {
      summary.errors++;
    }
  }

  return summary;
}
