import "dotenv/config";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { prisma } from "@/lib/db";
import { assertDisposablePostgres, announceDisposableDatabase } from "./lib/disposableDatabase";
import { cleanupFixtures, CANDIDATE_A, FIXTURE_EMAIL_DOMAIN } from "./lib/applicationFixtures";
import { seedFixtureProfile, signUpFixtureUser } from "./lib/fixtureSession";
import { startMockAtsServer, type MockAtsServer } from "./lib/mockAtsServer";
import { setSchedulerPaused } from "@/lib/sync/schedulerState";

/**
 * Harness for the safe application-agent suite.
 *
 * The previous version created a scratch SQLite file, hashed six tables of the
 * user's real `dev.db` through the libsql driver, and compared the hash
 * afterwards to prove the tests had not touched production data. On PostgreSQL
 * there is no file to copy, and that hash check has a better replacement: the
 * suite refuses to start unless DATABASE_URL names a database the operator
 * declared disposable, so there is no production data in reach to protect.
 *
 * What this process owns is the environment the child suite needs: a disposable
 * database with migrations applied, a production Next server, an account that
 * actually signed up (every route reads the session cookie and nothing else),
 * and that account's profile. The child does the asserting.
 */

const FIXTURE = "Application agent contract";

function run(command: string, args: string[], env: NodeJS.ProcessEnv, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited with code ${code}.`))));
  });
}

async function waitForServer(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fetch(url).then((response) => response.status < 500).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Test server did not become ready at ${url}.`);
}

async function main(): Promise<void> {
  const database = assertDisposablePostgres(FIXTURE);
  announceDisposableDatabase(FIXTURE, database);

  const testRoot = path.join(process.cwd(), "data", "test-runs");
  await mkdir(testRoot, { recursive: true });
  const tempRoot = await mkdtemp(path.join(testRoot, "agent-"));
  const tempName = path.basename(tempRoot);
  if (!/^agent-[A-Za-z0-9]+$/.test(tempName)) throw new Error("Unexpected temporary test directory name.");

  const port = 31_000 + (process.pid % 1_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const isolatedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    BASE_URL: baseUrl,
    BETTER_AUTH_URL: baseUrl,
    NEXT_PUBLIC_APP_URL: baseUrl,
    ISOLATED_TEST_MODE: "1",
    TEST_TEMP_ROOT: tempRoot,
    GENERATED_OUTPUT_DIR: path.join(tempRoot, "documents"),
    APPLICATION_OUTPUT_DIR: path.join(tempRoot, "application-runs"),
    APPLICATION_BROWSER_PROFILE_DIR: path.join(tempRoot, "browser-profile"),
    APPLICATION_WORKER_LOCK_PATH: path.join(tempRoot, "application-worker.lock.json"),
    DISABLE_VISION_AGENT: "1",
    FORCE_HEADLESS: "1",
  };

  let server: ReturnType<typeof spawn> | null = null;
  let mockAts: MockAtsServer | null = null;
  try {
    await run(process.execPath, [path.join(process.cwd(), "node_modules", "prisma", "build", "index.js"), "migrate", "deploy"], isolatedEnv, "disposable database migration");
    await cleanupFixtures();
    // Background discovery makes live network calls and writes jobs. Neither
    // belongs in a deterministic fixture run, so the scheduler is paused before
    // the server that would start it comes up.
    await setSchedulerPaused(true);

    server = spawn(process.execPath, [path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)], {
      cwd: process.cwd(),
      env: isolatedEnv,
      stdio: "inherit",
      windowsHide: true,
    });
    await waitForServer(`${baseUrl}/api/extension/health`);

    // The employer is a separate origin with no session of its own — see
    // scripts/lib/mockAtsServer.ts.
    mockAts = await startMockAtsServer(port + 1);

    // A real sign-up, so the child holds a session the server actually issued.
    const email = `agent-suite${FIXTURE_EMAIL_DOMAIN}`;
    const session = await signUpFixtureUser(baseUrl, email, `${CANDIDATE_A.legalFirstName} ${CANDIDATE_A.legalLastName}`);
    await seedFixtureProfile(session.userId, { ...CANDIDATE_A, email });

    await run(process.execPath, ["--import", "tsx", "scripts/test-application-agent-isolated.ts"], {
      ...isolatedEnv,
      // The worker fills for exactly one named account. Left unset it would
      // refuse to guess, which is the correct behaviour and the wrong thing to
      // leave a fixture depending on.
      APPLICATION_WORKER_USER_ID: session.userId,
      AGENT_TEST_USER_ID: session.userId,
      AGENT_TEST_SESSION_COOKIE: session.cookie,
      AGENT_TEST_EMAIL: email,
      MOCK_ATS_BASE_URL: mockAts.baseUrl,
    }, "isolated application-agent suite");
  } finally {
    await mockAts?.close().catch(() => {});
    if (server && server.exitCode === null) server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await cleanupFixtures().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    const resolvedTemp = path.resolve(tempRoot);
    if (resolvedTemp.startsWith(path.resolve(testRoot)) && path.basename(resolvedTemp).startsWith("agent-")) {
      await rm(resolvedTemp, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
