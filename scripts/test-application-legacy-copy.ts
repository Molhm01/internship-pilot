import "dotenv/config";
import { prisma } from "@/lib/db";
import { validateAndNormalizeApplicationRun, ApplicationValidationError } from "@/lib/applications/validation";
import { planWithSchemaCorrection } from "@/lib/applications/browserAgent";
import { assertDisposablePostgres, announceDisposableDatabase } from "./lib/disposableDatabase";
import { cleanupFixtures, createFixtureJob, createFixtureUser, CANDIDATE_A } from "./lib/applicationFixtures";

/**
 * Legacy-row safety, on PostgreSQL.
 *
 * The old version copied the user's real `dev.db`, reached into it for a
 * specific production job id, and mutated the `ApplicationProfile` singleton.
 * All three are gone. What it was actually proving is worth keeping, so it is
 * rebuilt over rows this fixture creates:
 *
 *  - a legacy run (no HTTPS `officialApplyUrl`, a retired `fill_only` mode, an
 *    `unknown` ATS type, malformed JSON in `answers`) is normalized into a
 *    shape the browser can be trusted with, rather than being handed to
 *    Chromium as-is;
 *  - a genuinely missing required fact fails with a readable path/expected/
 *    received issue *before* any browser module is reached;
 *  - a run with no owner is refused outright;
 *  - an invalid model plan is corrected on retry and, if it stays invalid,
 *    becomes a safe pause instead of a thrown ZodError.
 */

const FIXTURE = "Application legacy-row safety";
let failures = 0;

function check(condition: unknown, message: string): void {
  if (condition) console.log(`  PASS: ${message}`);
  else {
    console.error(`  FAIL: ${message}`);
    failures += 1;
  }
}

async function main(): Promise<void> {
  const database = assertDisposablePostgres(FIXTURE);
  announceDisposableDatabase(FIXTURE, database);

  try {
    await cleanupFixtures();
    const user = await createFixtureUser(CANDIDATE_A);
    const officialUrl = "https://jobs.lever.co/fixture-employer/00000000-0000-4000-8000-000000000000/apply";
    const jobId = await createFixtureJob(officialUrl);

    // A legacy job row: the official apply URL was never resolved, so only the
    // original `url` carries the destination.
    await prisma.job.update({ where: { id: jobId }, data: { officialApplyUrl: null, officialApplicationUrl: null } });

    // A legacy run: retired mode, unresolved ATS, malformed answer JSON.
    const legacyRun = await prisma.applicationRun.create({
      data: {
        userId: user.userId,
        jobId,
        mode: "fill_only",
        atsType: "unknown",
        status: "running",
        answers: "legacy-invalid-json",
        resumeDocumentId: "legacy-resume-document",
      },
    });

    console.log("1) A legacy run is normalized before any browser module is reached");
    const normalized = await validateAndNormalizeApplicationRun(legacyRun.id);
    const normalizedRun = await prisma.applicationRun.findUniqueOrThrow({ where: { id: legacyRun.id } });
    check(
      normalized.officialApplyUrl === officialUrl && normalized.officialApplyUrl.startsWith("https://"),
      `legacy job URL was promoted to an HTTPS officialApplyUrl (${normalized.officialApplyUrl})`,
    );
    check(normalizedRun.mode === "fill_to_submit", `retired run mode normalized to fill_to_submit (got ${normalizedRun.mode})`);
    check(normalizedRun.atsType === "lever", `ATS type detected from the destination (got ${normalizedRun.atsType})`);
    check(normalizedRun.answers === "{}", `malformed legacy answer JSON became a safe empty object (got ${normalizedRun.answers})`);

    console.log("\n2) The normalized profile belongs to the run's owner");
    check(normalized.profile.email === CANDIDATE_A.email, `profile email is the owner's (${normalized.profile.email})`);
    check(normalized.profile.school === CANDIDATE_A.school, `profile school is the owner's (${normalized.profile.school})`);
    check(
      normalized.approvedAnswers.every((answer) => answer.userId === user.userId),
      "the approved-answer bank contains only the owner's rows",
    );

    console.log("\n3) A missing required fact fails with a readable field issue");
    await prisma.userProfile.update({ where: { userId: user.userId }, data: { applicationEmail: null } });
    let missingEmail: ApplicationValidationError | null = null;
    try {
      await validateAndNormalizeApplicationRun(legacyRun.id);
    } catch (error) {
      if (error instanceof ApplicationValidationError) missingEmail = error;
      else throw error;
    }
    check(missingEmail !== null, "validation threw a structured ApplicationValidationError");
    check(missingEmail?.stage === "VALIDATING_RUN", `the failing stage is VALIDATING_RUN (got ${missingEmail?.stage})`);
    check(
      Boolean(missingEmail?.fieldIssues.some((issue) => issue.path === "email" && issue.received === "null")),
      `the issue names the field and what was received (${JSON.stringify(missingEmail?.fieldIssues.map((issue) => `${issue.path}=${issue.received}`))})`,
    );

    console.log("\n4) A run with no owner is refused rather than filled from anybody's data");
    const orphanRun = await prisma.applicationRun.create({
      data: { jobId, mode: "fill_to_submit", atsType: "lever", status: "running", resumeDocumentId: "legacy-resume-document" },
    });
    let orphanFailure: ApplicationValidationError | null = null;
    try {
      await validateAndNormalizeApplicationRun(orphanRun.id);
    } catch (error) {
      if (error instanceof ApplicationValidationError) orphanFailure = error;
      else throw error;
    }
    check(orphanFailure?.schemaName === "ApplicationRunOwner", `an ownerless run fails on ApplicationRunOwner (got ${orphanFailure?.schemaName})`);
    check(
      Boolean(orphanFailure?.fieldIssues.some((issue) => issue.path === "userId")),
      "the refusal names userId as the missing fact",
    );

    console.log("\n5) An invalid model plan is corrected, then becomes a safe pause");
    let requests = 0;
    const corrected = await planWithSchemaCorrection("test", "", "READING_FORM", async () => {
      requests += 1;
      return requests === 1 ? "{}" : '{"actions":[{"action":"continue"}]}';
    });
    check(!corrected.failure && corrected.attempts === 2, `an invalid model schema is corrected on retry (attempts ${corrected.attempts})`);
    const exhausted = await planWithSchemaCorrection("test", "", "READING_FORM", async () => "{}");
    check(
      exhausted.failure?.issues[0]?.path === "actions" && exhausted.failure.attempts === 3,
      "two correction retries end in a readable safe-pause issue rather than a thrown ZodError",
    );
  } finally {
    await cleanupFixtures();
    await prisma.$disconnect();
  }

  console.log(failures === 0
    ? "\nAll legacy-row safety checks PASSED."
    : `\n${failures} legacy-row safety check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
