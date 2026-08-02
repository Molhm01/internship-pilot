import { spawn } from "node:child_process";
import { getAgentDiagnostics } from "@/lib/applications/diagnostics";

async function testGate2Worker() {
  console.log("=== Testing Gate 2: Browser & Worker Ownership Diagnostics ===");

  const worker = spawn(process.execPath, ["--import", "tsx", "scripts/application-worker.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, APPLICATION_WORKER_OWNER: "1" },
    stdio: "inherit",
    windowsHide: true,
  });

  try {
    console.log("Spawned application worker (PID:", worker.pid, "). Waiting for startup...");
    await new Promise((resolve) => setTimeout(resolve, 4000));

    const diag = await getAgentDiagnostics();
    console.log("Agent Diagnostics Checks:");
    console.log("  browserCanLaunch:", diag.checks.browserCanLaunch);
    console.log("  browserProfileOwnedByOneWorker:", diag.checks.browserProfileOwnedByOneWorker);
    console.log("  extensionLoadedByWorker:", diag.checks.extensionLoadedByWorker);

    if (!diag.checks.browserCanLaunch.pass) {
      throw new Error(`FAIL: browserCanLaunch did not pass: ${diag.checks.browserCanLaunch.detail}`);
    }
    if (!diag.checks.browserProfileOwnedByOneWorker.pass) {
      throw new Error(`FAIL: browserProfileOwnedByOneWorker did not pass: ${diag.checks.browserProfileOwnedByOneWorker.detail}`);
    }
    if (!diag.checks.extensionLoadedByWorker.pass) {
      throw new Error(`FAIL: extensionLoadedByWorker did not pass: ${diag.checks.extensionLoadedByWorker.detail}`);
    }

    console.log("\nPASS: All Gate 2 checks (Browser launch, Profile ownership, Extension loaded) PASSED 100%.");
  } finally {
    worker.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

void testGate2Worker();
