import {
  WEB_PORT, REPO_ROOT,
  readLock, clearLock, pidAlive, describePortOwner, serverHealth,
  stopProcessTree, fetchRunningInstance, expectedInstance, waitForPortFree, portInUse,
} from "./local-shared";
import { stoppablePids, orphanRecoveryTarget } from "@/lib/runtime/localStartup";

// Stops ONLY the Internship Pilot services this repository started (npm run
// local:stop). It never kills an arbitrary process on the port and never
// touches unrelated Node apps — it acts on the PIDs recorded in this repo's
// lockfile, and on a process holding the port only when that process itself
// reports the same repository root.

function stopPid(pid: number, label: string): boolean {
  if (!pidAlive(pid)) { console.log(`  ${label}: PID ${pid} already stopped.`); return false; }
  if (stopProcessTree(pid)) {
    console.log(`  ${label}: stopped PID ${pid}.`);
    return true;
  }
  console.error(`  ${label}: could not stop PID ${pid}.`);
  return false;
}

/**
 * The recovery path for a crash that lost the lockfile while leaving the web
 * server alive. Without it, a repository-owned orphan on port 3000 could only
 * be cleared by hand — which is precisely the "just kill node.exe" advice this
 * launcher exists to avoid. Ownership is proven by the server itself: it must
 * answer /api/local/instance with this checkout's repo-root hash.
 */
async function recoverOrphanOnPort(): Promise<boolean> {
  if (!(await portInUse(WEB_PORT))) return false;

  const owner = describePortOwner(WEB_PORT);
  const running = await fetchRunningInstance();
  const target = orphanRecoveryTarget({
    portOwnerPid: owner.pid,
    runningInstance: running,
    expectedRepoRootHash: expectedInstance().repoRootHash,
  });

  if (!target) {
    const health = await serverHealth();
    console.log(
      `Note: port ${WEB_PORT} is used by ${owner.name}${owner.pid ? ` (PID ${owner.pid})` : ""}${health.healthy ? " and reports healthy" : ""}, ` +
      "but it did not identify itself as this repository's server, so it is left untouched.",
    );
    return false;
  }

  console.log(target.detail);
  const stopped = stopPid(target.pid, "Orphaned web server");
  if (stopped) await waitForPortFree(WEB_PORT);
  return stopped;
}

async function main() {
  console.log(`Stopping Internship Pilot (repo: ${REPO_ROOT})`);
  const lock = readLock();

  if (lock && lock.repoRoot !== REPO_ROOT) {
    console.error(`Lockfile repoRoot (${lock.repoRoot}) does not match this repo. Refusing to stop — run local:stop from the owning repository.`);
    process.exitCode = 1;
    return;
  }

  let stopped = 0;
  const targets = stoppablePids({
    repoRoot: REPO_ROOT,
    lock: lock
      ? {
          repoRoot: lock.repoRoot,
          supervisorPid: lock.supervisorPid,
          webPid: lock.webPid,
          schedulerPid: lock.schedulerPid ?? null,
          workerPid: lock.workerPid,
        }
      : null,
    isAlive: pidAlive,
    selfPid: process.pid,
  });

  for (const target of targets) {
    if (stopPid(target.pid, target.label)) stopped += 1;
  }

  // Even with a clean lock, a web process can survive its supervisor. Sweep
  // for a repository-owned orphan afterwards so `local:stop` genuinely leaves
  // the port free.
  if (await recoverOrphanOnPort()) stopped += 1;

  if (lock) clearLock();

  if (stopped > 0) console.log(`Stopped ${stopped} process(es)${lock ? " and cleared the lock" : ""}.`);
  else if (lock) console.log("No live recorded processes; cleared the stale lock.");
  else console.log("Nothing running that this repository owns.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
