import "dotenv/config";
import { prisma } from "@/lib/db";

// Idempotent repair for ApplicationRun records that failed ONLY because of the
// old NOT_TAILORED_NO_JOB_DESCRIPTION blocker (an incomplete official job
// description). The new policy uses a master-resume fallback instead, so these
// runs should become retryable.
//
// This script:
//   - keeps the original audit event (never deleted)
//   - marks the old error as superseded by the new fallback policy
//   - clears stale transient run locks (activeKey) and moves the run to a clean
//     retryable "failed" state so a retry creates a FRESH attempt
//   - never duplicates a submitted application
//   - never auto-submits or auto-queues anything
// Safe to run any number of times.

const SUPERSEDED_PREFIX = "SUPERSEDED_BY_FALLBACK_POLICY";

async function main() {
  const candidates = await prisma.applicationRun.findMany({
    where: { errorLog: { contains: "NOT_TAILORED_NO_JOB_DESCRIPTION" } },
    include: { job: { include: { applicationRuns: true } } },
  });

  let examined = 0;
  let repaired = 0;
  let alreadyRepaired = 0;
  let skippedSubmitted = 0;
  let staleLocksCleared = 0;

  for (const run of candidates) {
    examined++;
    if ((run.errorLog ?? "").startsWith(SUPERSEDED_PREFIX)) {
      alreadyRepaired++;
      continue;
    }
    // Never touch a job that already has a submitted application.
    if (run.job.applicationRuns.some((r) => r.status === "submitted")) {
      skippedSubmitted++;
      continue;
    }

    const hadActiveLock = run.activeKey !== null && run.status !== "failed";
    if (hadActiveLock) staleLocksCleared++;

    await prisma.applicationRun.update({
      where: { id: run.id },
      data: {
        status: "failed", // clean retryable state; retry creates a fresh attempt
        activeKey: null, // clear any stale transient lock
        errorLog: `${SUPERSEDED_PREFIX}: The incomplete-job-description blocker was removed. This run is now retryable and will select a master-resume fallback if needed. Prior error: ${run.errorLog}`,
        currentStep: "SUPERSEDED_BY_FALLBACK_POLICY",
        needsUserActionReason: null,
        stoppedFieldLabel: null,
        stoppedFieldType: null,
        stoppedFieldOptions: null,
        stoppedFieldStep: null,
        stoppedFieldContext: null,
        finishedAt: new Date(),
      },
    });
    // Preserve history with a NEW append-only audit event (original kept).
    await prisma.auditLogEntry.create({
      data: {
        jobId: run.jobId,
        actor: "application-agent",
        action: "run-superseded-by-fallback-policy",
        detail: "Marked a NOT_TAILORED_NO_JOB_DESCRIPTION failure as superseded. The job is now eligible for a fresh retry using the master-resume fallback policy.",
        metadata: JSON.stringify({ runId: run.id }),
      },
    });
    repaired++;
  }

  console.log("=== NOT_TAILORED run repair summary ===");
  console.log(`runs examined:            ${examined}`);
  console.log(`runs repaired (retryable):${repaired}`);
  console.log(`already repaired:         ${alreadyRepaired}`);
  console.log(`skipped (submitted):      ${skippedSubmitted}`);
  console.log(`stale locks cleared:      ${staleLocksCleared}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
