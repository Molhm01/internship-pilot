import { spawn, spawnSync, execSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  WEB_PORT, BASE_URL, REPO_ROOT,
  LOCAL_PRISMA_NAME,
  portInUse, describePortOwner, serverHealth,
  readLock, writeLock, clearLock, lockIsStale, pidAlive, waitForHealthy, databasePath,
} from "./local-shared";

// Canonical one-command local startup for Internship Pilot (npm run local).
// Starts/reuses local Prisma Postgres, applies migrations, verifies the DB, then
// supervises THREE sibling Node processes:
//   1) Next.js website
//   2) durable radar/scheduler/ATS-scoring worker
//   3) application/browser worker
//
// Keeping the scheduler outside Next is deliberate. Importing PostgreSQL and
// discovery code through instrumentation made Windows Webpack try to bundle
// Node built-ins from pg/pgpass (`fs`, then `path`) as browser modules.

const production = process.argv.includes("--production");
const nextCli = path.join(REPO_ROOT, "node_modules", "next", "dist", "bin", "next");
const WORKSPACE_URL = `${BASE_URL}/jobs`;
const children: ChildProcess[] = [];
let stopping = false;
let webRestarts = 0;
let schedulerRestarts = 0;
let workerRestarts = 0;
const MAX_WEB_RESTARTS = 2;
const MAX_SCHEDULER_RESTARTS = 2;
const MAX_WORKER_RESTARTS = 2;

function log(msg: string) { console.log(`[local] ${msg}`); }

function run(cmd: string, args: string[]): number {
  try {
    execSync([cmd, ...args].join(" "), { stdio: "inherit", cwd: REPO_ROOT, env: process.env });
    return 0;
  } catch {
    return 1;
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function redactDatabaseUrls(value: string): string {
  return value.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgres://<local-url-redacted>");
}

function configureLocalEnvironment(): void {
  if (production) return;
  delete process.env.DATABASE_URL;
  delete process.env.SHADOW_DATABASE_URL;
  process.env.DATABASE_POOL_MAX = "1";
  process.env.INTERNSHIP_PILOT_RUNTIME = "local";
  process.env.DOCUMENT_STORAGE_DRIVER = "local";
  process.env.NEXT_PUBLIC_APP_URL = BASE_URL;
  process.env.BETTER_AUTH_URL = BASE_URL;
  if (!process.env.AI_MATCH_WORKER_CONCURRENCY) process.env.AI_MATCH_WORKER_CONCURRENCY = "1";
}

async function ensureLocalDatabase(): Promise<void> {
  if (production) return;

  log("Starting or reusing local Prisma Postgres…");
  const result = spawnSync(
    "npx",
    ["prisma", "dev", "--detach", "--name", LOCAL_PRISMA_NAME],
    {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const output = stripAnsi(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  const match = output.match(/postgres(?:ql)?:\/\/[^\s]+/i);
  if (!match) {
    console.error("✗ Prisma Dev did not report a local PostgreSQL TCP URL.");
    if (output.trim()) console.error(redactDatabaseUrls(output.trim()));
    if (result.error) console.error(result.error.message);
    process.exit(1);
  }

  const databaseUrl = match[0];
  let port: number;
  try {
    const parsed = new URL(databaseUrl);
    port = Number(parsed.port);
    if (!Number.isFinite(port) || port <= 0) throw new Error("missing TCP port");
  } catch {
    console.error("✗ Prisma Dev returned a database URL whose local TCP port could not be read.");
    process.exit(1);
  }

  process.env.DATABASE_URL = databaseUrl;

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await portInUse(port)) {
      log(`✓ Local Prisma Postgres ready on its actual TCP port ${port}.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.error(`✗ Prisma reported local database port ${port}, but it did not begin listening within 30 seconds.`);
  if (result.status && result.status !== 0 && output.trim()) console.error(redactDatabaseUrls(output.trim()));
  process.exit(1);
}

function checkOllama(): void {
  if (production) return;
  log("Checking Ollama…");
  try {
    execSync("ollama list", { stdio: "ignore", cwd: REPO_ROOT });
    log(`✓ Ollama is available. ATS scoring concurrency=${process.env.AI_MATCH_WORKER_CONCURRENCY ?? "1"}.`);
  } catch {
    console.warn("[local] ⚠ Ollama is not available. The website can still run, but local AI/autofill features may be unavailable until Ollama is installed/running.");
  }
}

function startChild(
  args: string[],
  onUnexpectedExit: (code: number | null, signal: NodeJS.Signals | null) => void,
): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  children.push(child);
  child.once("exit", (code, signal) => {
    if (!stopping) onUnexpectedExit(code, signal);
  });
  return child;
}

async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  log("Shutting down website, scheduler, and application worker…");
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(children.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    setTimeout(resolve, 5_000).unref();
  })));
  clearLock();
  process.exit(code);
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

function openBrowser(url: string) {
  try {
    if (process.platform === "win32") execSync(`start "" "${url}"`, { stdio: "ignore", shell: "cmd.exe" });
    else if (process.platform === "darwin") execSync(`open "${url}"`, { stdio: "ignore" });
    else execSync(`xdg-open "${url}"`, { stdio: "ignore" });
  } catch { /* best-effort */ }
}

async function main(): Promise<void> {
  log(`Repository: ${REPO_ROOT}`);
  configureLocalEnvironment();
  await ensureLocalDatabase();
  log(`Database:   ${databasePath()}`);

  if (await portInUse(WEB_PORT)) {
    const health = await serverHealth();
    if (health.healthy) {
      log("Internship Pilot is already running.");
      log(`Open ${WORKSPACE_URL}`);
      openBrowser(WORKSPACE_URL);
      process.exit(0);
    }
    const owner = describePortOwner(WEB_PORT);
    console.error(`\n✗ Port ${WEB_PORT} is in use by ${owner.name}${owner.pid ? ` (PID ${owner.pid})` : ""}, which is NOT a healthy Internship Pilot server.`);
    console.error(`  Stop that process, then run \`npm run local\` again. Internship Pilot never switches ports because the extension targets ${BASE_URL}.\n`);
    process.exit(1);
  }

  const existing = readLock();
  if (existing && !lockIsStale(existing)) {
    log("An Internship Pilot supervisor lock is present with live PIDs but port is free — another instance may be starting. Refusing to double-start.");
    process.exit(1);
  }
  if (existing) { log("Removing a stale lock from a previous crashed run."); clearLock(); }

  log("Applying migrations (prisma migrate deploy)…");
  if (run("npx", ["prisma", "migrate", "deploy"]) !== 0) {
    console.error("✗ Migration failed against the LOCAL database.");
    process.exit(1);
  }
  log("Generating Prisma client…");
  if (run("npx", ["prisma", "generate"]) !== 0) {
    console.error("✗ Prisma Client generation failed.");
    process.exit(1);
  }
  log("Verifying database connection…");
  if (run("npx", ["tsx", "scripts/test-db.ts"]) !== 0) {
    console.error("✗ Local database verification failed. The website was not started.");
    process.exit(1);
  }
  log("✓ Local database verified.");
  checkOllama();

  writeLock({
    repoRoot: REPO_ROOT,
    port: WEB_PORT,
    startedAt: new Date().toISOString(),
    supervisorPid: process.pid,
    webPid: null,
    schedulerPid: null,
    workerPid: null,
    databaseDisplay: databasePath(),
  });

  let web: ChildProcess | null = null;
  let scheduler: ChildProcess | null = null;
  let worker: ChildProcess | null = null;

  const updateLockPids = () => {
    const lock = readLock();
    if (!lock || !pidAlive(lock.supervisorPid)) return;
    writeLock({
      ...lock,
      webPid: web?.pid ?? null,
      schedulerPid: scheduler?.pid ?? null,
      workerPid: worker?.pid ?? null,
    });
  };

  const startWeb = (): ChildProcess => {
    const devArgs = process.platform === "win32" ? [nextCli, "dev", "--webpack"] : [nextCli, "dev"];
    const webArgs = production ? [nextCli, "start"] : devArgs;
    return startChild(webArgs, (code, signal) => {
      if (webRestarts < MAX_WEB_RESTARTS) {
        webRestarts += 1;
        console.error(`[local] web server exited unexpectedly (${signal ?? `code ${code}`}). Restarting (${webRestarts}/${MAX_WEB_RESTARTS})…`);
        setTimeout(() => {
          if (stopping) return;
          web = startWeb();
          updateLockPids();
        }, 1_500).unref();
        return;
      }
      console.error(`[local] web server keeps exiting after ${MAX_WEB_RESTARTS} restart attempts. Stopping.`);
      void shutdown(code ?? 1);
    });
  };

  const startScheduler = (): ChildProcess => startChild(
    ["--import", "tsx", "scripts/scheduler-worker.ts"],
    (code, signal) => {
      if (schedulerRestarts < MAX_SCHEDULER_RESTARTS) {
        schedulerRestarts += 1;
        console.error(`[local] scheduler/scoring worker exited (${signal ?? `code ${code}`}). Restarting (${schedulerRestarts}/${MAX_SCHEDULER_RESTARTS})…`);
        setTimeout(() => {
          if (stopping) return;
          scheduler = startScheduler();
          updateLockPids();
        }, 1_500).unref();
        return;
      }
      console.error("[local] scheduler/scoring worker keeps exiting; stopping because radar and ATS scoring would be unavailable.");
      void shutdown(code ?? 1);
    },
  );

  const startWorker = (): ChildProcess => startChild(
    ["--import", "tsx", "scripts/application-worker.ts"],
    (code, signal) => {
      if (workerRestarts < MAX_WORKER_RESTARTS) {
        workerRestarts += 1;
        console.error(`[local] application worker exited (${signal ?? `code ${code}`}). Restarting (${workerRestarts}/${MAX_WORKER_RESTARTS})…`);
        setTimeout(() => {
          if (stopping) return;
          worker = startWorker();
          updateLockPids();
        }, 1_500).unref();
      } else {
        console.error("[local] application worker keeps exiting; leaving the website + radar up WITHOUT browser autofill. Restart later after fixing Chromium/Ollama.");
        worker = null;
        updateLockPids();
      }
    },
  );

  log(`Starting web server${!production && process.platform === "win32" ? " (Webpack stability mode)" : ""}…`);
  web = startWeb();
  log("Starting radar + ATS scheduler worker…");
  scheduler = startScheduler();
  log("Starting application/browser worker…");
  worker = startWorker();
  updateLockPids();

  log("Waiting for the server to become healthy…");
  const healthy = await waitForHealthy(90_000);
  if (healthy) {
    log(`✓ Internship Pilot is healthy at ${BASE_URL}`);
    log(`✓ Scheduler/scoring worker PID ${scheduler.pid ?? "unknown"}.`);
    log(`Opening Discover at ${WORKSPACE_URL}…`);
    openBrowser(WORKSPACE_URL);
    log("Press Ctrl+C to stop the website + scheduler + worker. The local database remains available for your next run.");
  } else {
    console.error("[local] Server did not report healthy within 90s. Check the logs above.");
  }
}

void main();
