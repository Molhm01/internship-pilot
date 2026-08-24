import "dotenv/config";

import { prisma } from "@/lib/db";
import { upsertClassifiedAtsJob } from "@/lib/sync/ingest";
import {
  announceDisposableDatabase,
  assertDisposablePostgres,
} from "./lib/disposableDatabase";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`  PASS: ${message}`);
}

async function main() {
  const database = assertDisposablePostgres("Discovery + baseline integration contract");
  announceDisposableDatabase("Discovery + baseline integration contract", database);

  const marker = `discovery-score-${Date.now()}`;
  const email = `${marker}@example.test`;
  const sourceJobId = `${marker}-req`;
  const postedAt = new Date("2026-08-23T12:34:56.000Z");
  let userId: string | null = null;

  try {
    const user = await prisma.user.create({
      data: {
        email,
        name: "Discovery Score Fixture",
        resumeFacts: {
          create: [{
            type: "skill",
            content: "Embedded C and Python",
            detail: "Approved fixture evidence for deterministic integration testing.",
            status: "approved",
            source: "manual",
          }],
        },
      },
    });
    userId = user.id;

    const result = await upsertClassifiedAtsJob({
      source: "greenhouse",
      atsType: "greenhouse",
      atsTenant: marker,
      classification: "QUALIFYING_INTERNSHIP",
      classificationReason: "Disposable official-provider integration fixture.",
      job: {
        sourceJobId,
        requisitionId: sourceJobId,
        title: "Embedded Software Engineering Intern",
        company: "Northstar Embedded Systems",
        location: "Newark, NJ",
        postedAt,
        description:
          "Build and test embedded software using C and Python, document results, and collaborate with electrical and computer engineers.",
        applyUrl: `https://job-boards.greenhouse.io/${marker}/jobs/${sourceJobId}`,
        workplaceType: "Hybrid",
      },
    });
    assert(result === "new", "official provider ingest creates one new canonical job");

    const job = await prisma.job.findFirstOrThrow({
      where: { source: "greenhouse", sourceJobId },
      include: {
        userStates: { where: { userId: user.id } },
        initialAiMatchJobs: { where: { userId: user.id } },
      },
    });
    const state = job.userStates[0];
    assert(job.activeFeed, "new official job is active immediately");
    assert(job.sourcePostedAt?.getTime() === postedAt.getTime(), "sourcePostedAt remains the employer timestamp");
    assert(state != null && Number.isInteger(state.matchScore), "eligible user receives a numeric baseline in the ingest transaction");
    assert(state!.scoreSource === "BASELINE", "immediate numeric score is marked BASELINE");
    assert(job.initialAiMatchJobs.length === 1, "AI refinement is queued after the baseline exists");
    assert(job.initialAiMatchJobs[0]!.state === "PENDING", "discovery does not wait for or start Ollama");
  } finally {
    await prisma.job.deleteMany({ where: { source: "greenhouse", sourceJobId } }).catch(() => undefined);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
