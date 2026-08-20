import { spawn, execSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  WEB_PORT, BASE_URL, REPO_ROOT,
  LOCAL_PRISMA_NAME, LOCAL_PRISMA_HTTP_PORT, LOCAL_PRISMA_DB_PORT, LOCAL_PRISMA_SHADOW_DB_PORT,
  LOCAL_DATABASE_URL, LOCAL_SHADOW_DATABASE_URL,
  portInUse, describePortOwner, serverHealth,
  readLock, writeLock, clearLock, lockIsStale, pidAlive, waitForHealthy, databasePath,
} from "./local-shared";

// Canonical one-command local startup for Internship Pilot (npm run local).
// Starts a LOCAL Prisma Postgres database when needed, applies migrations,
// verifies the database, starts exactly ONE web+scheduler process and ONE
// application/browser worker, checks Ollama, waits for health, opens the browser,
// and shuts the app children down cleanly on Ctrl+C.
//
// Crucially, local development never trusts DATABASE_URL from .env. That file
// may still contain a suspended/paid cloud database URL; this supervisor always
// overrides it in-memory with the local Prisma Postgres TCP connection.

const production = process.argv.includes("--production");
const nextCli = path.join(REPO_ROOT, "node_modules", "next", "dist", "bin", "next");
const children: ChildProcess[] = [];
let stopping = false;
let workerRestarts = 0;
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

function configureLocalEnvironment(): void {
  if (production) return;

  // Override, do not merely default. A stale cloud DATABASE_URL in .env must
  // never consume quota or break local development again.
  process.env.DATABASE_URL = LOCAL_DATABASE_URL;
  process.env.SHADOW_DATABASE_URL = LOCAL_SHADOW_DATABASE_URL;
  process.env.DATABASE_POOL_MAX = "1";
  process.env.INTERNSHIP_PILOT_RUNTIME = "local";
  process.env.DOCUMENT_STORAGE_DRIVER = "local";
  process.env.NEXT_PUBLIC_APP_URL = BASE_URL;
  process.env.BETTER_AUTH_URL = BASE_URL;
}

async function ensureLocalDatabase(): Promise<void> {
  if (production) return;

  if (await portInUse(LOCAL_PRISMA_DB_PORT)) {
    log(`Local Prisma Postgres is already listening on port ${LOCAL_PRISMA_DB_PORT}.`);
    return;
  }

  log("Starting local Prisma Postgres in the background…");
  const exit = run("npx", [
    "prisma", "dev", "--detach",
    "--name", LOCAL_PRISMA_NAME,
    "--port", String(LOCAL_PRISMA_HTTP_PORT),
    "--db-port", String(LOCAL_PRISMA_DB_PORT),
    "--shadow-db-port", String(LOCAL_PRISMA_SHADOW_DB_PORT),
  ]);

  // A named instance may already have been started by another terminal between
  // our port check and the command. Treat an open DB port as success even when
  // the CLI reports that race as a non-zero exit.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await portInUse(LOCAL_PRISMA_DB_PORT)) {
      log(`✓ Local Prisma Postgres ready on port ${LOCAL_PRISMA_DB_PORT}.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (exit !== 0) {
    console.error("✗ Prisma could not start the local database. See the Prisma output above.");
  } else {
    console.error(`✗ Local database did not begin listening on port ${LOCAL_PRISMA_DB_PORT} within 30 seconds.`);
  }
  process.exit(1);
}

function checkOllama(): void {
  if (production) return;
  log("Checking Ollama…");
  try {
    execSync("ollama list", { stdio: "ignore", cwd: REPO_ROOT });
    log("✓ Ollama is available.");
  } catch {
    console.warn("[local] ⚠ Ollama is not available. The website can still run, but local AI/autofill features may be unavailable until Ollama is installed/running.");
  }
}

function startChild(label: string, args: string[], onUnexpectedExit: (code: number | null, signal: NodeJS.Signals | null) => void): ChildProcess {
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: process.env, stdio: "inherit", windowsHide: true });
  children.push(child);
  child.once("exit", (code, signal) => {
    if (stopping) return;
    onUnexpectedExit(code, signal);
  });
  return child;
}

async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  log("Shutting down website and application worker…");
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(children.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    setTimeout(resolve, 5_000).unref();
  })));
  clearLock();
  // The detached local database intentionally remains available between runs.
  // It is local-only and persistent, so the next `npm run local` starts faster
  // and keeps discovered jobs/profile data instead of recreating an empty DB.
  process.exit(code);
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

function openBrowser(url: string) {
  try {
    if (process.platform === "win32") execSync(`start "" "${url}"`, { stdio: "ignore", shell: "cmd.exe" });
    else if (process.platform === "darwin") execSync(`open "${url}"`, { stdio: "ignore" });
    else execSync(`xdg-open "${url}"`, { stdio: "ignore" });
  } catch { /* opening the browser is best-effort */ }
}

async function main(): Promise<void> {
  log(`Repository: ${REPO_ROOT}`);

  configureLocalEnvironment();
  await ensureLocalDatabase();
  log(`Database:   ${databasePath()}`);

  // 1. Already-running detection — never start a second copy on a healthy one.
  if (await portInUse(WEB_PORT)) {
    const health = await serverHealth();
    if (health.healthy) {
      log("Internship Pilot is already running.");
      log(`Open ${BASE_URL}`);
      openBrowser(BASE_URL);
      process.exit(0);
    }
    const owner = describePortOwner(WEB_PORT);
    console.error(`\n✗ Port ${WEB_PORT} is in use by ${owner.name}${owner.pid ? ` (PID ${owner.pid})` : ""}, which is NOT a healthy Internship Pilot server.`);
    console.error("  Stop that program yourself, then run `npm run local` again. Internship Pilot never kills unrelated processes and never switches ports (the extension targets " + BASE_URL + ").\n");
    process.exit(1);
  }

  // 2. Clear only a proven-stale lock (all recorded PIDs dead).
  const existing = readLock();
  if (existing && !lockIsStale(existing)) {
    log("An Internship Pilot supervisor lock is present with live PIDs but port is free — another instance may be starting. Refusing to double-start.");
    process.exit(1);
  }
  if (existing) { log("Removing a stale lock from a previous crashed run."); clearLock(); }

  // 3. Ensure migrations + Prisma client + a real database query before any
  // long-running service starts. This turns database setup into part of the one
  // command rather than a separate manual checklist.
  log("Applying migrations (prisma migrate deploy)…");
  if (run("npx", ["prisma", "migrate", "deploy"]) !== 0) {
    console.error("✗ Migration failed against the LOCAL database. See the error above; no cloud database was contacted.");
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

  // 4. Start exactly one web+scheduler and one application worker.
  writeLock({ repoRoot: REPO_ROOT, port: WEB_PORT, startedAt: new Date().toISOString(), supervisorPid: process.pid, webPid: null, workerPid: null });

  log("Starting web server + scheduler…");
  const web = startChild("web", [nextCli, production ? "start" : "dev"], (code, signal) => {
    console.error(`[local] web server exited unexpectedly (${signal ?? `code ${code}`}). Stopping.`);
    void shutdown(code ?? 1);
  });

  log("Starting application/browser worker…");
  const startWorker = () => startChild("worker", ["--import", "tsx", "scripts/application-worker.ts"], (code, signal) => {
    // A worker crash must NOT take the website down. Restart it a couple of
    // times, then leave the site running without it and explain.
    if (workerRestarts < MAX_WORKER_RESTARTS) {
      workerRestarts++;
      console.error(`[local] application worker exited (${signal ?? `code ${code}`}). Restarting (${workerRestarts}/${MAX_WORKER_RESTARTS})…`);
      const w = startWorker();
      updateLockPids(web.pid ?? null, w.pid ?? null);
    } else {
      console.error("[local] application worker keeps exiting; leaving the website up WITHOUT the browser worker. Autofill runs will not process until it is healthy. Check Ollama/Chromium, then restart with `npm run local`.");
      updateLockPids(web.pid ?? null, null);
    }
  });
  const worker = startWorker();
  updateLockPids(web.pid ?? null, worker.pid ?? null);

  // 5. Wait for health, then open the browser.
  log("Waiting for the server to become healthy…");
  const healthy = await waitForHealthy(90_000);
  if (healthy) {
    log(`✓ Internship Pilot is healthy at ${BASE_URL}`);
    log("Opening the website…");
    openBrowser(BASE_URL);
    log("Press Ctrl+C to stop the website + worker. The local database remains available for your next run.");
  } else {
    console.error("[local] Server did not report healthy within 90s. It may still be compiling — check the logs above.");
  }
}

function updateLockPids(webPid: number | null, workerPid: number | null) {
  const lock = readLock();
  if (lock && pidAlive(lock.supervisorPid)) writeLock({ ...lock, webPid, workerPid });
}

void main();
