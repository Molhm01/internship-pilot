// Repair the employer-approval backlog.
//
// Two defects, both of which silently suppressed legitimate employers:
//
//   1. 190 NewEmployerReview rows are marked "approved", but 41 of them never
//      got a Company row — so approval had no effect and their jobs stayed
//      unreachable. This creates the missing allowlisted Company rows.
//
//   2. 210 rows are still "pending" and were never surfaced for a decision.
//      This reports them; it does NOT auto-approve them, because approving an
//      employer is a trust decision that belongs to the user, not to a script.
//
//   npm run employers:repair -- --dry-run
//   npm run employers:repair -- --apply

import { prisma } from "@/lib/db";
import { DEMO_OR_FIXTURE_COMPANY } from "@/lib/jobs/sourcePolicy";

function parseArgs(argv: string[]) {
  return { apply: argv.includes("--apply") };
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const mode = apply ? "APPLY" : "DRY-RUN";
  console.log(`[employers:repair] mode=${mode}\n`);

  const approved = await prisma.newEmployerReview.findMany({
    where: { status: "approved" },
    select: { employerName: true, guessedDomain: true, guessedCareersUrl: true },
  });
  const existing = new Set(
    (await prisma.company.findMany({ select: { name: true } })).map((c) => c.name.trim().toLowerCase()),
  );

  const notYetCreated = approved.filter((a) => !existing.has(a.employerName.trim().toLowerCase()));
  // Test/demo employers must never be promoted into the real allowlist — the
  // same exclusion the Active-feed policy already applies.
  const fixtures = notYetCreated.filter((a) => DEMO_OR_FIXTURE_COMPANY.test(a.employerName));
  const missing = notYetCreated.filter((a) => !DEMO_OR_FIXTURE_COMPANY.test(a.employerName));

  console.log(`  approved reviews           : ${approved.length}`);
  console.log(`  approved without a Company : ${notYetCreated.length}`);
  console.log(`  skipped as demo/fixture    : ${fixtures.length}`);
  console.log(`  eligible to create         : ${missing.length}\n`);

  let created = 0;
  let failed = 0;

  for (const review of missing) {
    try {
      if (apply) {
        await prisma.company.create({
          data: {
            name: review.employerName.trim(),
            // "jobright.ai" was recorded as the guessed domain for rows
            // discovered through the aggregator — it is the aggregator's own
            // host, never the employer's, so it must not become a careers URL.
            careersUrl:
              review.guessedCareersUrl && !/jobright\.ai/i.test(review.guessedCareersUrl)
                ? review.guessedCareersUrl
                : null,
            website:
              review.guessedDomain && !/jobright\.ai/i.test(review.guessedDomain)
                ? `https://${review.guessedDomain}`
                : null,
            atsType: "unknown",
            source: "intern-list-approved",
            allowlisted: true,
            monitoringStatus: "active",
          },
        });
      }
      created += 1;
      console.log(`  + ${review.employerName}`);
    } catch (error) {
      failed += 1;
      console.log(
        `  ! ${review.employerName}: ${error instanceof Error ? error.name : "create failed"}`,
      );
    }
  }

  const pending = await prisma.newEmployerReview.count({ where: { status: "pending" } });

  console.log(`\n[employers:repair] ${mode} complete`);
  console.log(`  Company rows ${apply ? "created" : "that would be created"}: ${created}`);
  console.log(`  failures     : ${failed}`);
  console.log(`  still pending review (needs YOUR decision, not auto-approved): ${pending}`);
  console.log(`\n  Next: npm run ats:resolve -- --apply   (find their ATS boards)`);
  if (!apply) console.log(`  Nothing was written. Re-run with --apply to persist.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[employers:repair] fatal", e);
    process.exit(1);
  });
