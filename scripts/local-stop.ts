import { execSync } from "node:child_process";
import {
  WEB_PORT, REPO_ROOT,
  readLock, clearLock, pidAlive, describePortOwner, serverHealth,
} from "./local-shared";

// Stops ONLY the Internship Pilot services this repository started (npm run
// local:stop). It never kills an arbitrary process on the port and never
// touches unrelated Node apps — it acts solely on the PIDs recorded in this
// repo's lockfile, and only after confirming they are still alive.

function stopPid(pid: number, label: string): boolean {
  if (!pidAlive(pid)) { console.log(`  ${label}: PID ${pid} already stopped.`); return false; }
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${pid} /t /f`, { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
    console.log(`  ${label}: stopped PID ${pid}.`);
    return true;
  } catch (err) {
    console.error(`  ${label}: could not stop PID ${pid} (${err instanceof Error ? err.message : String(err)}).`);
    return false;
  }
}

async function main() {
  console.log(`Stopping Internship Pilot (repo: ${REPO_ROOT})`);
  const lock = readLock();
  if (!lock) {
    console.log("No local supervisor lock found. Nothing to stop that this repository owns.");
    // Safety: if the port is held by a healthy server we did NOT record, we do
    // not stop it — the user must stop it where it was started.
    const owner = describePortOwner(WEB_PORT);
    if (owner.pid) {
      const health = await serverHealth();
      console.log(`Note: port ${WEB_PORT} is used by ${owner.name} (PID ${owner.pid})${health.healthy ? " and reports healthy" : ""}, but it is not recorded in this repo's lockfile, so it is left untouched.`);
    }
    return;
  }

  if (lock.repoRoot !== REPO_ROOT) {
    console.error(`Lockfile repoRoot (${lock.repoRoot}) does not match this repo. Refusing to stop — run local:stop from the owning repository.`);
    process.exitCode = 1;
    return;
  }

  let stopped = 0;
  if (lock.workerPid) stopped += stopPid(lock.workerPid, "Application worker") ? 1 : 0;
  if (lock.webPid) stopped += stopPid(lock.webPid, "Web server + scheduler") ? 1 : 0;
  if (lock.supervisorPid && lock.supervisorPid !== process.pid) stopped += stopPid(lock.supervisorPid, "Supervisor") ? 1 : 0;

  clearLock();
  console.log(stopped > 0 ? `Stopped ${stopped} process(es) and cleared the lock.` : "No live recorded processes; cleared the stale lock.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
