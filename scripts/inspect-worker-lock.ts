import fs from "node:fs";
import { readWorkerLock, isProcessRunning, workerLockPath } from "@/lib/applications/workerLock";

async function inspectLock() {
  const lock = await readWorkerLock();
  console.log("Current worker lock:", lock);
  if (lock) {
    const running = isProcessRunning(lock.pid);
    console.log(`Process PID ${lock.pid} running:`, running);
    if (running) {
      console.log(`Killing running process PID ${lock.pid} to ensure clean test environment...`);
      try {
        process.kill(lock.pid, "SIGTERM");
      } catch (e) {
        console.error("Could not kill process:", e);
      }
    }
    const lp = workerLockPath();
    if (fs.existsSync(lp)) {
      fs.unlinkSync(lp);
      console.log("Removed stale lock file:", lp);
    }
  }
}

void inspectLock();
