import {
  WEB_PORT, BASE_URL, REPO_ROOT,
  readLock, pidAlive, serverHealth, describePortOwner, databasePath,
} from "./local-shared";

// Reports the status of every local Internship Pilot service (npm run
// local:status). Read-only — never starts or stops anything.

function line(label: string, value: string) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function main() {
  console.log("Internship Pilot — local status");
  console.log("=".repeat(50));
  line("Repository", REPO_ROOT);

  const lock = readLock();
  line("Database", lock?.databaseDisplay ?? databasePath());
  line("URL", BASE_URL);

  const owner = describePortOwner(WEB_PORT);
  const health = await serverHealth();

  line("Website", health.healthy ? `RUNNING (healthy)${owner.pid ? ` PID ${owner.pid}` : ""}` : owner.pid ? `PORT ${WEB_PORT} used by ${owner.name} PID ${owner.pid} (not healthy)` : "STOPPED");
  if (health.healthy && health.body) {
    line("  build", String(health.body.build ?? "unknown"));
    line("  protocolVersion", String(health.body.protocolVersion ?? "unknown"));
    line("  submitEnabled", String(health.body.submitEnabled ?? "unknown"));
  }

  if (lock) {
    line("Supervisor", pidAlive(lock.supervisorPid) ? `RUNNING PID ${lock.supervisorPid}` : "not running");
    line("Web PID (lock)", lock.webPid ? `${lock.webPid} ${pidAlive(lock.webPid) ? "(alive)" : "(dead)"}` : "n/a");
    line("Scheduler PID", lock.schedulerPid ? `${lock.schedulerPid} ${pidAlive(lock.schedulerPid) ? "(alive)" : "(dead)"}` : "n/a");
    line("Worker PID (lock)", lock.workerPid ? `${lock.workerPid} ${pidAlive(lock.workerPid) ? "(alive)" : "(dead)"}` : "n/a");
    line("Started at", lock.startedAt);
  } else {
    line("Supervisor lock", "none (not started via npm run local, or cleanly stopped)");
  }

  line("Scheduler + scoring", lock?.schedulerPid && pidAlive(lock.schedulerPid) ? `RUNNING PID ${lock.schedulerPid}` : "STOPPED");
  line("Application worker", lock?.workerPid && pidAlive(lock.workerPid) ? `RUNNING PID ${lock.workerPid}` : "STOPPED");

  // Browser + extension readiness, if the diagnostics endpoint is up.
  try {
    const res = await fetch(`${BASE_URL}/api/agent-diagnostics`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const d = (await res.json()) as Record<string, unknown>;
      line("Browser worker", String(d.browserHealthy ?? d.worker ?? "see /api/agent-diagnostics"));
      line("Extension", String(d.extensionId ?? d.extensionReady ?? "see /api/agent-diagnostics"));
    } else {
      line("Browser/extension", `agent-diagnostics HTTP ${res.status}`);
    }
  } catch {
    line("Browser/extension", "unavailable (server not up)");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
