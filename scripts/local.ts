import { spawn, spawnSync, execSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  WEB_PORT, BASE_URL, REPO_ROOT,
  LOCAL_PRISMA_NAME,
  portInUse, describePortOwner, serverHealth,
  readLock, writeLock, clearLock, lockIsStale, pidAlive, waitForHealthy, databasePath,
} from "./local-shared";

// Canonical one-command local startup for Internship Pilot (npm run local).
// Starts/reuses a LOCAL Prisma Postgres database, reads the ACTUAL TCP URL that
// Prisma reports (ports may move when defaults are occupied), applies migrations,
// verifies the DB, starts exactly ONE web+scheduler process and ONE browser worker,
// checks Ollama, waits for health, and opens the browser.
//
// Local development never trusts DATABASE_URL from .env. That file may still
// contain a suspended/paid cloud database URL; this supervisor replaces it in
// memory with Prisma Dev's local TCP URL before any app query runs.

const production = process.argv.includes("--production");
const nextCli = path.join(REPO_ROOT, "node_modules", "next", "dist", "bin", "next");
const WORKSPACE_URL = `${BASE_URL}/jobs`;
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

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function redactDatabaseUrls(value: string): string {
  return value.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgres://<local-url-redacted>");
}

function configureLocalEnvironment(): void {
  if (production) return;

  // Clear inherited/cloud DB settings first. ensureLocalDatabase() injects the
  // real local URL after Prisma tells us which TCP port the named instance uses.
  delete process.env.DATABASE_URL;
  delete process.env.SHADOW_DATABASE_URL;
  process.env.DATABASE_POOL_MAX = "1";
  process.env.INTERNSHIP_PILOT_RUNTIME = "local";
  process.env.DOCUMENT_STORAGE_DRIVER = "local";
  process.env.NEXT_PUBLIC_APP_URL = BASE_URL;
  process.env.BETTER_AUTH_URL = BASE_URL;
}

async function ensureLocalDatabase(): Promise<void> {
  if (production) return;

  log("Starting or reusing local Prisma Postgres…");

  // Do NOT assume 51214. Prisma Dev may reuse a named server that was created
  // on another port or move to a free port if defaults are occupied. Detached
  // mode prints the real TCP connection URL; that output is our source of truth.
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

  // Inject only into this supervisor + its children. The user's .env remains
  // untouched, and the suspended cloud DB cannot receive local development traffic.
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
  if (result.status && result.status !== 0 && output.trim()) {
    console.error(redactDatabaseUrls(output.trim()));
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
  // Detached Prisma Dev intentionally remains available between runs; the data
  // is local and persistent, so the next `npm run local` starts quickly.
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
      log(`Open ${WORKSPACE_URL}`);
      openBrowser(WORKSPACE_URL);
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
  // long-running service starts.
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
  writeLock({
    repoRoot: REPO_ROOT,
    port: WEB_PORT,
    startedAt: new Date().toISOString(),
    supervisorPid: process.pid,
    webPid: null,
    workerPid: null,
    databaseDisplay: databasePath(),
  });

  log("Starting web server + scheduler…");
  const web = startChild("web", [nextCli, production ? "start" : "dev"], (code, signal) => {
    console.error(`[local] web server exited unexpectedly (${signal ?? `code ${code}`}). Stopping.`);
    void shutdown(code ?? 1);
  });

  log("Starting application/browser worker…");
  const startWorker = () => startChild("worker", ["--import", "tsx", "scripts/application-worker.ts"], (code, signal) => {
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

  // 5. Wait for health, then open the signed-in workspace instead of the
  // marketing/root route. Local development is about testing the product, and
  // /jobs is the canonical Discover screen where radar + ATS progress is visible.
  log("Waiting for the server to become healthy…");
  const healthy = await waitForHealthy(90_000);
  if (healthy) {
    log(`✓ Internship Pilot is healthy at ${BASE_URL}`);
    log(`Opening Discover at ${WORKSPACE_URL}…`);
    openBrowser(WORKSPACE_URL);
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
