import "dotenv/config";
import { prisma } from "@/lib/db";
import { validateAndNormalizeApplicationRun, ApplicationValidationError } from "@/lib/applications/validation";
import { planWithSchemaCorrection } from "@/lib/applications/browserAgent";

if (process.env.LEGACY_COPY_TEST !== "1") throw new Error("Refusing to mutate a database outside the disposable legacy-copy harness.");
let failures = 0;
function check(value: unknown, message: string) {
  if (value) console.log(`  PASS: ${message}`);
  else { failures += 1; console.error(`  FAIL: ${message}`); }
}

async function main() {
  const legacyRuns = await prisma.applicationRun.count();
  const supersededRuns = await prisma.applicationRun.count({ where: { status: "superseded" } });
  check(legacyRuns > 0 && supersededRuns > 0, `real legacy records are present in the copied database (${legacyRuns} runs, ${supersededRuns} superseded)`);

  const job = await prisma.job.findUnique({ where: { id: "cmrwsl2xq008dfokuzzs7ykoy" } });
  const run = await prisma.applicationRun.findFirst({ where: { jobId: job?.id, status: "failed" }, orderBy: { createdAt: "desc" } });
  if (!job || !run || !job.url) throw new Error("Copied production Lightship job/failed run is unavailable.");
  await prisma.job.update({ where: { id: job.id }, data: { officialApplyUrl: null } });
  await prisma.applicationRun.update({ where: { id: run.id }, data: { status: "running", mode: "fill_only", atsType: "unknown", answers: "legacy-invalid-json", resumeDocumentId: run.resumeDocumentId } });
  await prisma.applicationProfile.update({ where: { id: "default" }, data: { locationPreferences: "legacy-invalid-json" } });

  const normalized = await validateAndNormalizeApplicationRun(run.id);
  const normalizedRun = await prisma.applicationRun.findUniqueOrThrow({ where: { id: run.id } });
  const normalizedProfile = await prisma.applicationProfile.findUniqueOrThrow({ where: { id: "default" } });
  check(normalized.officialApplyUrl === job.url && normalized.officialApplyUrl.startsWith("https://"), "legacy job URL migrated to HTTPS officialApplyUrl");
  check(normalizedRun.mode === "fill_to_submit" && normalizedRun.atsType === "lever", "legacy run mode and ATS type normalized before browser use");
  check(normalizedRun.answers === "{}" && normalizedProfile.locationPreferences === null, "malformed optional legacy JSON received safe empty/null defaults");

  await prisma.applicationProfile.update({ where: { id: "default" }, data: { email: null } });
  let requiredFailure: ApplicationValidationError | null = null;
  try { await validateAndNormalizeApplicationRun(run.id); } catch (error) { if (error instanceof ApplicationValidationError) requiredFailure = error; else throw error; }
  check(requiredFailure?.stage === "VALIDATING_RUN" && requiredFailure.fieldIssues.some((issue) => issue.path === "email" && issue.received === "null"), "missing required Candidate Profile email fails with path/received/expected before any browser module is called");

  let requests = 0;
  const corrected = await planWithSchemaCorrection("test", "", "READING_FORM", async () => {
    requests += 1;
    return requests === 1 ? "{}" : '{"actions":[{"action":"continue"}]}';
  });
  check(!corrected.failure && corrected.attempts === 2, "invalid model schema is corrected on retry");
  const exhausted = await planWithSchemaCorrection("test", "", "READING_FORM", async () => "{}");
  check(exhausted.failure?.issues[0]?.path === "actions" && exhausted.failure.attempts === 3, "two correction retries end in a readable safe-pause issue instead of a thrown ZodError");

  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
