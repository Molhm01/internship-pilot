import "dotenv/config";
import { prisma } from "@/lib/db";
import { queueJobsForMatching, scoreNextQueuedJob, __setScorerForTests, __stopScoringWorkerForTests } from "@/lib/matching/scoringQueue";

// Deterministic Score-All integration test with a MOCK scorer (no live Ollama).
// Proves >= 20 jobs transition NOT_SCORED → QUEUED → SCORING → SCORED, and that
// the queue is durable in SQLite (Job.scoringState).
//
// ISOLATION: fixtures use a unique company and a top scoringPriority, and the
// test sets QUEUED state DIRECTLY (never calls the shared background trigger),
// so the single-threaded manual drain only ever claims these fixtures and never
// touches real jobs.

const N = 22;
const COMPANY = "Test Scoring Queue Co";
// Scoring is per user: queueing and draining both name whose scores these are.
const FIXTURE_EMAIL = "scoring-queue-fixture@example.test";
const TOP_PRIORITY = 100000;

let failures = 0;
function check(cond: boolean, msg: string) { if (cond) console.log(`  PASS: ${msg}`); else { console.error(`  FAIL: ${msg}`); failures++; } }

async function cleanup() {
  await prisma.job.deleteMany({ where: { company: COMPANY } });
  await prisma.user.deleteMany({ where: { email: FIXTURE_EMAIL } });
}

async function main() {
  await cleanup();
  const owner = await prisma.user.create({ data: { email: FIXTURE_EMAIL, name: "Scoring Queue Fixture", emailVerified: true } });

  // 1. Create N unscored fixtures.
  const ids: string[] = [];
  for (let i = 0; i < N; i++) {
    const job = await prisma.job.create({
      data: {
        title: `Scoring Fixture Intern ${i}`, company: COMPANY,
        description: "Python and SQL internship for a Computer Science student. GPA 3.0+.",
        status: "DISCOVERED", source: "intern-list", sourceJobId: `test-scoring-${i}`,
        verificationStatus: "ACTIVE_SOURCE_LISTED", activeFeed: true, scoringState: "NOT_SCORED",
        firstSeenAt: new Date(), lastSeenAt: new Date(),
      },
    });
    ids.push(job.id);
  }
  check((await prisma.job.count({ where: { company: COMPANY, scoringState: "NOT_SCORED" } })) === N, `all ${N} fixtures start NOT_SCORED`);

  // 1b. queueJobsForMatching COUNTING. queueJobsForMatching starts a 100ms
  //     drain timer; we assert on its synchronous return and stop that timer
  //     within the same window so it never drains (isolation).
  const firstQueue = await queueJobsForMatching({ userId: owner.id, jobId: ids[0] });
  __stopScoringWorkerForTests();
  check(firstQueue.newlyQueued === 1 && firstQueue.eligible === 1, `queueing a NOT_SCORED job reports newlyQueued=1 (got ${JSON.stringify(firstQueue)})`);
  const reQueue = await queueJobsForMatching({ userId: owner.id, jobId: ids[0] });
  __stopScoringWorkerForTests();
  check(reQueue.alreadyQueued === 1 && reQueue.newlyQueued === 0, `re-queueing a QUEUED job reports alreadyQueued=1 (got ${JSON.stringify(reQueue)})`);

  // 2. Durably queue ALL fixtures at top priority (direct state write — no
  //    shared background trigger, so this test's single-threaded manual drain
  //    stays fully isolated from real queued jobs). The queueJobsForMatching
  //    endpoint counting is covered separately by test:scoring-queue-counts.
  await prisma.job.updateMany({
    where: { company: COMPANY },
    data: { scoringState: "QUEUED", scoringPriority: TOP_PRIORITY, scoringQueuedAt: new Date(), scoringError: null },
  });
  check((await prisma.job.count({ where: { company: COMPANY, scoringState: "QUEUED" } })) === N, `all ${N} fixtures are durably QUEUED in SQLite`);

  // 3. Mock scorer: asserts SCORING state when invoked; records a score. Guards
  //    against ever touching a non-fixture job (belt-and-suspenders isolation).
  let sawScoring = 0;
  __setScorerForTests(async (jobId: string) => {
    const job = await prisma.job.findUnique({ where: { id: jobId }, select: { scoringState: true, company: true } });
    if (job?.company !== COMPANY) throw new Error("Refusing to mock-score a non-fixture job");
    if (job.scoringState === "SCORING") sawScoring++;
    await prisma.job.update({ where: { id: jobId }, data: { matchScore: 72, eligibilityStatus: "Pass" } });
  });

  try {
    // 4. Drain exactly N fixtures single-threaded (top priority ⇒ claimed first).
    let processed = 0;
    for (let i = 0; i < N; i++) if (await scoreNextQueuedJob(owner.id)) processed++;
    check(processed === N, `drained ${N} jobs (got ${processed})`);
    check(sawScoring === N, `every fixture observed in SCORING during scoring (got ${sawScoring})`);
    check((await prisma.job.count({ where: { company: COMPANY, scoringState: "SCORED" } })) === N, `all ${N} fixtures reached SCORED`);
    check((await prisma.job.count({ where: { company: COMPANY, matchScore: { not: null } } })) === N, `all ${N} fixtures have a persisted matchScore`);
    check((await prisma.job.count({ where: { company: COMPANY, scoringState: { in: ["QUEUED", "SCORING"] } } })) === 0, `no fixture left stuck in QUEUED/SCORING`);
  } finally {
    __setScorerForTests(null);
  }

  await cleanup();
  console.log(failures === 0 ? "\nAll scoring-queue tests PASSED." : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => { console.error("Scoring-queue test crashed:", e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
