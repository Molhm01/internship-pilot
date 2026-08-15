/**
 * Claims the data this database held before it had accounts.
 *
 * Internship Pilot ran for one person. Their profile, résumé, generated
 * documents, application history and saved answers are all still here, and
 * after the multi-user migration they carry no owner: `userId` is null, and the
 * application profile is still a singleton row keyed `"default"`. Nothing reads
 * unowned rows any more, so from the website that data is invisible — it is not
 * lost, it is unclaimed.
 *
 * This script assigns it, once, to one explicitly named account.
 *
 * ## The rules it will not break
 *
 * - **The target is named, never guessed.** No "first user", no "the only
 *   user", no "the user whose email looks right". A wrong guess here hands one
 *   person's résumé, address and demographic answers to another, and there is
 *   no undo for that.
 * - **`--dry-run` is the default posture.** Nothing is written without
 *   `--apply`.
 * - **It refuses ambiguity.** If a private table already contains rows owned by
 *   somebody *other* than the target, the run stops rather than merging two
 *   people's data into one account.
 * - **It is idempotent.** Running it twice claims nothing the second time.
 * - **It prints counts, never content.** No name, no email body, no résumé
 *   text, no answer, no token, no demographic value reaches the log.
 * - **Canonical data is not touched.** Job, Company, ApprovedAtsTenant,
 *   verification and discovery rows are shared and are read only to copy the
 *   original user's own tracker state off them.
 *
 * ## Usage
 *
 *   npx tsx scripts/claim-legacy-user-data.ts --user <userId>
 *   npx tsx scripts/claim-legacy-user-data.ts --email <address>
 *   npx tsx scripts/claim-legacy-user-data.ts --user <userId> --apply
 *   npx tsx scripts/claim-legacy-user-data.ts --verify
 *
 * `--verify` claims nothing; it reports whether any unowned private rows
 * remain.
 */

import "dotenv/config";
import { prisma } from "../src/lib/db";

type Args = {
  userId?: string;
  email?: string;
  apply: boolean;
  verify: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, verify: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--user" || flag === "--user-id") args.userId = argv[++index];
    else if (flag === "--email") args.email = argv[++index];
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--dry-run") args.apply = false;
    else if (flag === "--verify") args.verify = true;
  }
  return args;
}

/** Every table that holds private rows and can carry a null owner. */
const CLAIMABLE = [
  "resumeFact",
  "resumeDocument",
  "resumeBullet",
  "generatedDocument",
  "companyRelationshipFact",
  "matchResult",
  "initialAiMatchJob",
  "applicationRun",
  "savedFilter",
  "trackedEmail",
  "assessmentInboxEntry",
  "education",
  "experience",
  "project",
  "approvedAnswer",
] as const;

type Claimable = (typeof CLAIMABLE)[number];

/* eslint-disable @typescript-eslint/no-explicit-any -- One loop over fifteen
   delegates. Prisma types each model's `where` separately, so the alternative
   is fifteen near-identical blocks; the shape used (`{ userId: null }`) is
   identical for every one of them and is checked by the schema. */
function delegate(model: Claimable): any {
  return (prisma as any)[model];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function countUnowned(): Promise<Map<Claimable, number>> {
  const counts = new Map<Claimable, number>();
  for (const model of CLAIMABLE) {
    counts.set(model, await delegate(model).count({ where: { userId: null } }));
  }
  return counts;
}

async function countOwnedByOthers(targetUserId: string): Promise<Map<Claimable, number>> {
  const counts = new Map<Claimable, number>();
  for (const model of CLAIMABLE) {
    const count = await delegate(model).count({
      where: { userId: { not: null, notIn: [targetUserId] } },
    });
    if (count > 0) counts.set(model, count);
  }
  return counts;
}

function printCounts(title: string, counts: Map<Claimable, number>): number {
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  console.log(`\n${title}`);
  if (total === 0) {
    console.log("  (none)");
    return 0;
  }
  for (const [model, count] of counts) {
    if (count > 0) console.log(`  ${model.padEnd(26)} ${count}`);
  }
  console.log(`  ${"TOTAL".padEnd(26)} ${total}`);
  return total;
}

async function resolveTarget(args: Args): Promise<{ id: string } | null> {
  if (args.userId) {
    const user = await prisma.user.findUnique({ where: { id: args.userId }, select: { id: true } });
    if (!user) {
      console.error("\nNo account has that id. Sign in once as the owner, then use the id shown by --verify.");
      return null;
    }
    return user;
  }
  if (args.email) {
    const email = args.email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) {
      console.error("\nNo account exists with that email address. Create it first, then re-run.");
      return null;
    }
    return user;
  }
  console.error(
    "\nName the account explicitly: --user <userId> or --email <address>.\n" +
      "This script will not choose an owner for you. Assigning one person's résumé,\n" +
      "address and demographic answers to the wrong account cannot be undone.",
  );
  return null;
}

/**
 * The original user's tracker state, copied off the shared Job rows.
 *
 * `Job.status`, `Job.matchScore` and `Job.eligibilityStatus` are the deprecated
 * per-person columns. Their values belong to the original user, so they become
 * that user's `UserJobState` — and the Job rows are left exactly as they are,
 * because the columns are dropped by a later migration, not by this script.
 */
async function claimJobState(userId: string, apply: boolean): Promise<number> {
  const jobs = await prisma.job.findMany({
    where: {
      OR: [
        { status: { not: "DISCOVERED" } },
        { matchScore: { not: null } },
        { eligibilityStatus: { not: null } },
      ],
    },
    select: { id: true, status: true, matchScore: true, eligibilityStatus: true },
  });

  if (!apply) return jobs.length;

  let written = 0;
  for (const job of jobs) {
    const existing = await prisma.userJobState.findUnique({
      where: { userId_jobId: { userId, jobId: job.id } },
    });
    // Idempotent: a state row that already exists is this user's current
    // answer and is never overwritten by the legacy value.
    if (existing) continue;
    await prisma.userJobState.create({
      data: {
        userId,
        jobId: job.id,
        applicationStatus: job.status,
        matchScore: job.matchScore,
        eligibilityStatus: job.eligibilityStatus,
      },
    });
    written += 1;
  }
  return written;
}

/**
 * The singleton application profile, moved into the models that own it.
 *
 * Only fields the target has not already filled in are copied: an account that
 * has entered its own address keeps it. Nothing is overwritten, and nothing is
 * printed.
 */
async function claimApplicationProfile(userId: string, apply: boolean): Promise<boolean> {
  const legacy = await prisma.applicationProfile.findUnique({ where: { id: "default" } });
  if (!legacy) return false;
  if (!apply) return true;

  const existing = await prisma.userProfile.findUnique({ where: { userId } });
  const keep = <T>(current: T | null | undefined, legacyValue: T | null | undefined) =>
    current ?? legacyValue ?? null;

  await prisma.userProfile.upsert({
    where: { userId },
    create: {
      userId,
      legalFirstName: legacy.legalFirstName,
      middleName: legacy.legalMiddleName,
      legalLastName: legacy.legalLastName,
      preferredName: legacy.preferredName,
      applicationEmail: legacy.email ?? legacy.applicationEmail,
      alternateEmail: legacy.alternateEmail,
      phone: legacy.phone,
      phoneCountryCode: legacy.phoneCountryCode,
      addressLine1: legacy.addressStreet,
      addressLine2: legacy.addressLine2,
      city: legacy.addressCity,
      state: legacy.addressState,
      postalCode: legacy.addressZip,
      country: legacy.countryOfResidence,
      linkedinUrl: legacy.linkedin,
      githubUrl: legacy.github,
      portfolioUrl: legacy.portfolio ?? legacy.website,
    },
    update: {
      legalFirstName: keep(existing?.legalFirstName, legacy.legalFirstName),
      middleName: keep(existing?.middleName, legacy.legalMiddleName),
      legalLastName: keep(existing?.legalLastName, legacy.legalLastName),
      preferredName: keep(existing?.preferredName, legacy.preferredName),
      applicationEmail: keep(existing?.applicationEmail, legacy.email ?? legacy.applicationEmail),
      alternateEmail: keep(existing?.alternateEmail, legacy.alternateEmail),
      phone: keep(existing?.phone, legacy.phone),
      phoneCountryCode: keep(existing?.phoneCountryCode, legacy.phoneCountryCode),
      addressLine1: keep(existing?.addressLine1, legacy.addressStreet),
      addressLine2: keep(existing?.addressLine2, legacy.addressLine2),
      city: keep(existing?.city, legacy.addressCity),
      state: keep(existing?.state, legacy.addressState),
      postalCode: keep(existing?.postalCode, legacy.addressZip),
      country: keep(existing?.country, legacy.countryOfResidence),
      linkedinUrl: keep(existing?.linkedinUrl, legacy.linkedin),
      githubUrl: keep(existing?.githubUrl, legacy.github),
      portfolioUrl: keep(existing?.portfolioUrl, legacy.portfolio ?? legacy.website),
    },
  });

  const preferences = await prisma.applicationPreferences.findUnique({ where: { userId } });
  await prisma.applicationPreferences.upsert({
    where: { userId },
    create: {
      userId,
      willingToRelocate: legacy.willingToRelocate,
      remotePreference: legacy.remotePreference,
      earliestStartDate: legacy.earliestStartDate,
      salaryPreference: legacy.salaryAnswerPreference,
      hasDriversLicense: legacy.hasDriversLicense,
      securityClearanceStatus: legacy.securityClearanceStatus,
      usualJobSource: legacy.referralSource,
      requiresSponsorshipNow: legacy.requiresSponsorship,
    },
    update: {
      willingToRelocate: keep(preferences?.willingToRelocate, legacy.willingToRelocate),
      remotePreference: keep(preferences?.remotePreference, legacy.remotePreference),
      earliestStartDate: keep(preferences?.earliestStartDate, legacy.earliestStartDate),
      salaryPreference: keep(preferences?.salaryPreference, legacy.salaryAnswerPreference),
      hasDriversLicense: keep(preferences?.hasDriversLicense, legacy.hasDriversLicense),
      securityClearanceStatus: keep(
        preferences?.securityClearanceStatus,
        legacy.securityClearanceStatus,
      ),
      usualJobSource: keep(preferences?.usualJobSource, legacy.referralSource),
      requiresSponsorshipNow: keep(preferences?.requiresSponsorshipNow, legacy.requiresSponsorship),
    },
  });

  // Demographic answers are copied only where the original user actually chose
  // one. A null stays null: the agent must ask rather than answer.
  const sensitive = await prisma.sensitiveAnswerPreferences.findUnique({ where: { userId } });
  await prisma.sensitiveAnswerPreferences.upsert({
    where: { userId },
    create: {
      userId,
      gender: legacy.eeoGender,
      raceEthnicity: legacy.eeoRaceEthnicity,
      veteranStatus: legacy.eeoVeteranStatus,
      disabilityStatus: legacy.eeoDisabilityStatus,
      pronouns: legacy.pronouns,
    },
    update: {
      gender: keep(sensitive?.gender, legacy.eeoGender),
      raceEthnicity: keep(sensitive?.raceEthnicity, legacy.eeoRaceEthnicity),
      veteranStatus: keep(sensitive?.veteranStatus, legacy.eeoVeteranStatus),
      disabilityStatus: keep(sensitive?.disabilityStatus, legacy.eeoDisabilityStatus),
      pronouns: keep(sensitive?.pronouns, legacy.pronouns),
    },
  });

  // The legacy Education fields, when this account has no education entry yet.
  const hasEducation = (await prisma.education.count({ where: { userId } })) > 0;
  if (!hasEducation && legacy.school) {
    await prisma.education.create({
      data: {
        userId,
        school: legacy.school,
        degree: legacy.degreeType,
        major: legacy.major,
        minor: legacy.minor,
        gpa: legacy.gpa,
        educationLevel: legacy.educationLevel,
        relevantCoursework: legacy.relevantCoursework,
        startYear: legacy.educationStartDate?.slice(0, 4) ?? null,
        startMonth: legacy.educationStartDate?.slice(5, 7) ?? null,
        graduationYear: legacy.graduationDate?.slice(0, 4) ?? null,
        graduationMonth: legacy.graduationDate?.slice(5, 7) ?? null,
      },
    });
  }

  // The legacy row is left in place. It is unread by the application, and
  // deleting the source in the same run that copies it removes the only way to
  // check the copy afterwards.
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log("Legacy data ownership");
  console.log("=====================");

  const unowned = await countUnowned();

  if (args.verify) {
    const total = printCounts("Unowned private rows", unowned);
    const legacyProfile = await prisma.applicationProfile.count({ where: { id: "default" } });
    console.log(`\n  legacy ApplicationProfile singleton: ${legacyProfile}`);
    const users = await prisma.user.count();
    console.log(`  accounts: ${users}`);
    if (total === 0 && legacyProfile === 0) {
      console.log("\nNothing is unclaimed. Every private row has an owner.");
    } else {
      console.log("\nUnclaimed data remains. Run with --user <id> --apply to assign it.");
    }
    return;
  }

  const target = await resolveTarget(args);
  if (!target) {
    process.exitCode = 1;
    return;
  }

  // Ambiguity check. Two owners in one private table means this database has
  // already been used by more than one person, and "the legacy rows" is no
  // longer a well-defined set.
  const others = await countOwnedByOthers(target.id);
  if (others.size > 0) {
    printCounts("Rows already owned by a DIFFERENT account", others);
    console.error(
      "\nRefusing to continue. Another account already owns private rows in this database,\n" +
        "so which rows are 'the original user's' is ambiguous. Resolve that first —\n" +
        "no data has been changed.",
    );
    process.exitCode = 1;
    return;
  }

  const claimableTotal = printCounts("Unowned private rows", unowned);
  const jobStates = await claimJobState(target.id, false);
  const hasLegacyProfile = await claimApplicationProfile(target.id, false);
  console.log(`\n  Job rows carrying legacy personal state: ${jobStates}`);
  console.log(`  legacy ApplicationProfile singleton:     ${hasLegacyProfile ? 1 : 0}`);

  if (!args.apply) {
    console.log(
      "\nDRY RUN. Nothing was written.\n" +
        "Re-run with --apply to assign the rows above to the named account.",
    );
    return;
  }

  console.log("\nApplying…");
  let claimed = 0;
  for (const model of CLAIMABLE) {
    const result = await delegate(model).updateMany({
      where: { userId: null },
      data: { userId: target.id },
    });
    if (result.count > 0) {
      console.log(`  ${model.padEnd(26)} ${result.count}`);
      claimed += result.count;
    }
  }

  const stateRows = await claimJobState(target.id, true);
  await claimApplicationProfile(target.id, true);

  console.log(`\n  private rows claimed:       ${claimed}`);
  console.log(`  UserJobState rows written:  ${stateRows}`);
  console.log(`  application profile moved:  ${hasLegacyProfile ? "yes" : "nothing to move"}`);
  console.log(`  (expected from the dry run: ${claimableTotal})`);

  const remaining = await countUnowned();
  const remainingTotal = [...remaining.values()].reduce((sum, value) => sum + value, 0);
  if (remainingTotal === 0) {
    console.log("\nDone. No unowned private rows remain.");
  } else {
    printCounts("Still unowned", remaining);
    console.error("\nSome rows were not claimed. Re-run to retry; this script is idempotent.");
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    // The message only — never the stack, which on a Prisma error can quote the
    // failing row, and these rows are somebody's personal data.
    console.error("\nFailed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
