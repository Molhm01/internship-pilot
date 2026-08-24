import "dotenv/config";
import path from "node:path";
import { readdir, rm } from "node:fs/promises";
import { chromium } from "playwright";
import { prisma } from "@/lib/db";
import { fillGenericForm } from "@/lib/applications/formFiller";
import { applicationProfileForUser } from "@/lib/profile/applicationProfile";
import { applicationNarrativeForUser, fillContextProfile } from "@/lib/applications/fillProfile";
import type { FillContext } from "@/lib/applications/types";
import { assertDisposablePostgres, announceDisposableDatabase } from "./lib/disposableDatabase";
import { cleanupFixtures, createTwoUserWorld, type FixtureUser } from "./lib/applicationFixtures";

/**
 * DOM fallback regression, on PostgreSQL.
 *
 * The previous version copied the user's real `dev.db` and read a singleton
 * `ApplicationProfile` row with `id = "default"`. Both are gone: Internship
 * Pilot runs on PostgreSQL, and the profile is assembled per user from the
 * models that own it. This rebuild proves the same three things the old one did
 * — normal labeled fields get filled, Submit is never clicked, no unrelated
 * document is produced — plus the one it structurally could not: user B's
 * profile never reaches user A's form.
 *
 * Nothing here copies or mutates a real database. It creates its own users,
 * job and runs in a database the operator declared disposable, and deletes them.
 */

const FIXTURE = "Application DOM fallback regression";
let failures = 0;

function check(condition: unknown, message: string): void {
  if (condition) console.log(`  PASS: ${message}`);
  else {
    console.error(`  FAIL: ${message}`);
    failures += 1;
  }
}

const FORM_HTML = `
  <form id="application">
    <label for="full-name">Full name</label><input id="full-name" name="fullName" required>
    <label for="email">Email</label><input id="email" type="email" name="email" required>
    <label for="telephone">Telephone</label><input id="telephone" type="tel" name="telephone" required>
    <label for="address">Street address</label><input id="address" name="address">
    <label for="school">School</label><input id="school" name="school" required>
    <label for="degree">Degree</label><input id="degree" name="degree" required>
    <button type="submit">Submit application</button>
  </form>
  <script>
    window.__submitted = false;
    document.querySelector("#application").addEventListener("submit", (event) => {
      event.preventDefault();
      window.__submitted = true;
    });
  </script>
`;

type FilledValues = {
  name: string;
  email: string;
  phone: string;
  school: string;
  degree: string;
  submitted: boolean;
};

async function fillFormForUser(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  user: FixtureUser,
  jobId: string,
  runId: string,
  runDirectory: string,
): Promise<{ status: string; values: FilledValues; error?: string; stopReason?: string }> {
  // Read the profile exactly the way the worker does, through the user-owned
  // assembler. A test that hand-built the profile would prove nothing about
  // whether the production read path is scoped.
  const profile = await applicationProfileForUser(user.userId);
  if (!profile) throw new Error(`Fixture user ${user.email} has no assembled application profile.`);
  const narrative = await applicationNarrativeForUser(user.userId);

  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  try {
    // tsx compiles this file with esbuild, which names every function through a
    // `__name` helper — including the closures Playwright serializes into the
    // page. The shim supplies it, and the reload is what makes an init script
    // registered after the page already exists actually run.
    await page.addInitScript(() => {
      const browserWindow = window as unknown as { __name?: (fn: unknown, name: string) => unknown };
      browserWindow.__name = browserWindow.__name || ((fn: unknown) => fn);
    });
    await page.reload();
    await page.setContent(FORM_HTML);

    const ctx: FillContext = {
      jobId,
      runId,
      jobTitle: "DOM fallback fixture",
      company: "Local fixture only",
      applyUrl: "http://localhost/dom-fallback",
      mode: "fill_to_submit",
      profile: fillContextProfile(profile),
      resumeFilePath: null,
      coverLetterFilePath: null,
      coverLetterText: null,
      ...narrative,
      approvedRunAnswers: {},
    };

    const result = await fillGenericForm(page, ctx, runDirectory);
    const values = await page.evaluate(() => ({
      name: (document.querySelector("#full-name") as HTMLInputElement).value,
      email: (document.querySelector("#email") as HTMLInputElement).value,
      phone: (document.querySelector("#telephone") as HTMLInputElement).value,
      school: (document.querySelector("#school") as HTMLInputElement).value,
      degree: (document.querySelector("#degree") as HTMLInputElement).value,
      submitted: (window as unknown as { __submitted: boolean }).__submitted,
    }));
    return { status: result.status, values, error: result.error, stopReason: result.stopReason };
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  const database = assertDisposablePostgres(FIXTURE);
  announceDisposableDatabase(FIXTURE, database);
  if (process.env.DISABLE_VISION_AGENT !== "1") {
    // Set here rather than demanded from the caller: the point of this fixture
    // is the deterministic DOM path, and a vision model must not be able to
    // rescue a fallback that failed.
    process.env.DISABLE_VISION_AGENT = "1";
  }

  const runDirectory = path.join("data", "generated", "diagnostics", `dom-fallback-${process.pid}`);
  const browser = await chromium.launch({ headless: true });

  // Documents created by anything other than this fixture must be untouched, so
  // count them before and after rather than trusting the fill not to write.
  const documentsBefore = await prisma.generatedDocument.count();

  try {
    await cleanupFixtures();
    const world = await createTwoUserWorld("https://fixture.internship-pilot.test/apply/1");
    const [userA, userB] = world.users;
    const [runA, runB] = world.runIds;

    console.log("1) DOM fallback fills every normal labeled field without vision");
    const a = await fillFormForUser(browser, userA, world.jobId, runA, runDirectory);
    check(a.status === "filled", `fill completed with status "filled" (got "${a.status}"${a.error ? `: ${a.error}` : ""}${a.stopReason ? ` / ${a.stopReason}` : ""})`);
    check(Boolean(a.values.name), `legal name filled (got "${a.values.name}")`);
    check(Boolean(a.values.email), `email filled (got "${a.values.email}")`);
    check(Boolean(a.values.phone), `phone filled (got "${a.values.phone}")`);
    check(Boolean(a.values.school), `school filled (got "${a.values.school}")`);
    check(Boolean(a.values.degree), `degree filled (got "${a.values.degree}")`);

    console.log("\n2) DOM fallback never clicks Submit");
    check(a.values.submitted === false, "the fixture form's submit handler never fired");

    console.log("\n3) Filled values are this user's own facts");
    check(
      a.values.name === `${userA.candidate.legalFirstName} ${userA.candidate.legalLastName}`,
      `legal name is user A's (${a.values.name})`,
    );
    check(a.values.email === userA.candidate.email, `email is user A's (${a.values.email})`);
    check(a.values.school === userA.candidate.school, `school is user A's (${a.values.school})`);
    check(a.values.degree === userA.candidate.degree, `degree is user A's (${a.values.degree})`);

    console.log("\n4) User B's profile never reaches user A's form");
    const b = await fillFormForUser(browser, userB, world.jobId, runB, runDirectory);
    check(b.status === "filled", `user B's fill also completed (got "${b.status}")`);
    check(b.values.name === `${userB.candidate.legalFirstName} ${userB.candidate.legalLastName}`, `user B's form carries user B's name (${b.values.name})`);
    check(b.values.email === userB.candidate.email, `user B's form carries user B's email (${b.values.email})`);
    check(b.values.school === userB.candidate.school, `user B's form carries user B's school (${b.values.school})`);
    check(b.values.degree === userB.candidate.degree, `user B's form carries user B's degree (${b.values.degree})`);

    const aValues = Object.values(a.values).filter((value): value is string => typeof value === "string");
    const bLeaked = [userB.candidate.legalLastName, userB.candidate.email, userB.candidate.school, userB.candidate.degree, userB.candidate.phone]
      .filter((secret) => aValues.some((value) => value.includes(secret)));
    check(bLeaked.length === 0, `no user-B fact appears in user A's filled form${bLeaked.length ? ` (leaked: ${bLeaked.join(", ")})` : ""}`);

    console.log("\n5) No unrelated documents were generated or copied");
    const documentsAfter = await prisma.generatedDocument.count();
    check(documentsAfter === documentsBefore, `GeneratedDocument count unchanged (${documentsBefore} -> ${documentsAfter})`);

    console.log("\n6) Neither run was advanced past filling");
    const runs = await prisma.applicationRun.findMany({ where: { id: { in: [runA, runB] } } });
    check(runs.length === 2, "both fixture runs still exist");
    check(runs.every((run) => run.status !== "submitted"), "no run reached submitted");
    check(runs.every((run) => !run.confirmationNumber), "no confirmation number was recorded");
    check(runs.every((run) => run.userId === userA.userId || run.userId === userB.userId), "every run is still owned by its fixture user");
  } finally {
    await browser.close();
    // Only this fixture's own diagnostics directory, and only if it is inside
    // the workspace's generated tree.
    const absoluteRunDirectory = path.resolve(process.cwd(), runDirectory);
    if (absoluteRunDirectory.startsWith(path.resolve(process.cwd(), "data", "generated"))) {
      await rm(absoluteRunDirectory, { recursive: true, force: true });
    }
    await cleanupFixtures();
    const leftover = await readdir(path.resolve(process.cwd(), "data", "generated", "diagnostics")).catch(() => [] as string[]);
    if (leftover.some((entry) => entry === path.basename(runDirectory))) {
      console.error(`  FAIL: fixture diagnostics directory ${runDirectory} was not removed.`);
      failures += 1;
    }
    await prisma.$disconnect();
  }

  console.log(failures === 0
    ? "\nAll DOM fallback regression checks PASSED."
    : `\n${failures} DOM fallback regression check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
