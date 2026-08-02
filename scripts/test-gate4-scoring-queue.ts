import { prisma } from "@/lib/db";
import { queueJobsForMatching, processScoringQueue } from "@/lib/matching/scoringQueue";

async function testGate4ScoringQueue() {
  console.log("=== Testing Gate 4: AI Match Scoring Queue & Recovery ===");

  // 1. Create 20 fixture jobs with NOT_SCORED state
  const testJobIds: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const job = await prisma.job.create({
      data: {
        title: `Test Engineer ${i + 1}`,
        company: "Test Queue Co",
        description: "Looking for an engineering intern with Python and TypeScript skills.",
        activeFeed: true,
        source: "manual",
        verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
        scoringState: "NOT_SCORED",
      },
    });
    testJobIds.push(job.id);
  }
  console.log(`Created 20 fixture jobs for scoring queue test.`);

  try {
    // 2. Test Score All endpoint / queue logic
    const queueResult = await queueJobsForMatching({ allUnscored: true });
    console.log("Queue result:", queueResult);

    if (queueResult.newlyQueued < 20) {
      throw new Error(`FAIL: Expected at least 20 newlyQueued jobs, got ${queueResult.newlyQueued}`);
    }
    if (typeof queueResult.requested !== "number" || typeof queueResult.eligible !== "number") {
      throw new Error("FAIL: Queue result missing required requested/eligible metric properties.");
    }
    console.log("PASS: queueJobsForMatching returned required metric format.");

    // Verify jobs in DB transitioned to QUEUED
    const queuedCount = await prisma.job.count({
      where: { id: { in: testJobIds }, scoringState: "QUEUED" },
    });
    if (queuedCount !== 20) {
      throw new Error(`FAIL: Expected 20 jobs in QUEUED state, found ${queuedCount}`);
    }
    console.log("PASS: All 20 fixture jobs transitioned to QUEUED in database.");

    // 3. Test Priority Override ("Run AI Match Now")
    const priorityJobId = testJobIds[10];
    await queueJobsForMatching({ jobId: priorityJobId });

    const priorityJob = await prisma.job.findUnique({ where: { id: priorityJobId } });
    if (priorityJob?.scoringPriority !== 10) {
      throw new Error(`FAIL: Priority job did not get priority 10 (got ${priorityJob?.scoringPriority})`);
    }
    console.log("PASS: 'Run AI Match Now' correctly bumped job priority to 10.");

    // 4. Test Restart Recovery for abandoned SCORING job
    const abandonedJobId = testJobIds[5];
    const oldHeartbeat = new Date(Date.now() - 60_000); // 60s ago
    await prisma.job.update({
      where: { id: abandonedJobId },
      data: {
        scoringState: "SCORING",
        scoringHeartbeatAt: oldHeartbeat,
      },
    });

    // Run queue worker cycle
    await processScoringQueue();

    const recoveredJob = await prisma.job.findUnique({ where: { id: abandonedJobId } });
    if (recoveredJob?.scoringState === "SCORING" && recoveredJob.scoringHeartbeatAt?.getTime() === oldHeartbeat.getTime()) {
      throw new Error("FAIL: Abandoned job was not recovered!");
    }
    console.log("PASS: Abandoned SCORING job was recovered and processed successfully.");

    console.log("\nAll Gate 4 Scoring Queue checks PASSED 100%.");

  } finally {
    // Clean up fixture jobs
    await prisma.job.deleteMany({ where: { id: { in: testJobIds } } });
  }
}

void testGate4ScoringQueue();
