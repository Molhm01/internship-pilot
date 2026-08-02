import { spawn, execSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  WEB_PORT, BASE_URL, REPO_ROOT,
  portInUse, describePortOwner, serverHealth,
  readLock, writeLock, clearLock, lockIsStale, pidAlive, waitForHealthy, databasePath,
} from "./local-shared";

// Canonical one-command local startup for Internship Pilot (npm run local).
// Starts exactly ONE web+scheduler process and ONE application/browser worker,
// verifies migrations, waits for health, opens the browser, and shuts every
// child down cleanly on Ctrl+C. Never kills unrelated processes; never starts a
// second copy on top of a healthy one; never silently switches ports.

const production = process.argv.includes("--production");
const nextCli = path.join(REPO_ROOT, "node_modules", "next", "dist", "bin", "next");
const children: ChildProcess[] = [];
let stopping = false;
let workerRestarts = 0;
const MAX_WORKER_RESTARTS = 2;

function log(msg: string) { console.log(`[local] ${msg}`); }

function run(cmd: string, args: string[]): number {
  try {
    execSync([cmd, ...args].join(" "), { stdio: "inherit", cwd: REPO_ROOT });
    return 0;
  } catch {
    return 1;
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
  log("Shutting down services…");
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
  } catch { /* opening the browser is best-effort */ }
}

async function main(): Promise<void> {
  log(`Repository: ${REPO_ROOT}`);
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

  // 3. Ensure migrations + Prisma client.
  log("Applying migrations (prisma migrate deploy)…");
  if (run("npx", ["prisma", "migrate", "deploy"]) !== 0) { console.error("✗ Migration failed. Fix the database, then retry."); process.exit(1); }
  log("Generating Prisma client…");
  run("npx", ["prisma", "generate"]);

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
    log("Press Ctrl+C to stop all services.");
  } else {
    console.error("[local] Server did not report healthy within 90s. It may still be compiling — check the logs above.");
  }
}

function updateLockPids(webPid: number | null, workerPid: number | null) {
  const lock = readLock();
  if (lock && pidAlive(lock.supervisorPid)) writeLock({ ...lock, webPid, workerPid });
}

void main();
