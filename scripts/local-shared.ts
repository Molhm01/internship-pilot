import { createServer } from "node:net";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

// Shared helpers for the canonical local workflow (npm run local / local:status
// / local:stop). Everything is scoped to THIS repository via a lockfile that
// records the repo path and the PIDs this repo started — so local:stop can
// prove a process belongs here before ever stopping it, and never touches
// unrelated Node apps.

export const REPO_ROOT = process.cwd();
export const WEB_PORT = Number(process.env.PORT ?? 3000);
export const BASE_URL = `http://localhost:${WEB_PORT}`;
const LOCK_DIR = path.join(REPO_ROOT, ".internship-pilot");
const LOCK_FILE = path.join(LOCK_DIR, "local.json");

export type LocalLock = {
  repoRoot: string;
  port: number;
  startedAt: string;
  supervisorPid: number;
  webPid: number | null;
  workerPid: number | null;
};

export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createServer()
      .once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EADDRINUSE"))
      .once("listening", () => tester.close(() => resolve(false)))
      .listen(port, "0.0.0.0");
  });
}

export function describePortOwner(port: number): { pid: number | null; name: string } {
  try {
    if (process.platform === "win32") {
      const line = execSync(`netstat -ano -p tcp | findstr LISTENING | findstr :${port}`, { encoding: "utf8" })
        .split(/\r?\n/).find(Boolean) ?? "";
      const pid = Number(line.trim().split(/\s+/).pop());
      if (pid) {
        let name = "unknown";
        try { name = execSync(`tasklist /fi "PID eq ${pid}" /nh /fo csv`, { encoding: "utf8" }).split(",")[0]?.replace(/"/g, "") ?? "unknown"; } catch {}
        return { pid, name };
      }
    } else {
      const pid = Number(execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: "utf8" }).split(/\r?\n/).find(Boolean));
      if (pid) return { pid, name: "process" };
    }
  } catch {}
  return { pid: null, name: "another process" };
}

export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function readLock(): LocalLock | null {
  try {
    if (!existsSync(LOCK_FILE)) return null;
    return JSON.parse(readFileSync(LOCK_FILE, "utf8")) as LocalLock;
  } catch { return null; }
}

export function writeLock(lock: LocalLock): void {
  if (!existsSync(LOCK_DIR)) mkdirSync(LOCK_DIR, { recursive: true });
  writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2), "utf8");
}

export function clearLock(): void {
  try { if (existsSync(LOCK_FILE)) rmSync(LOCK_FILE); } catch {}
}

// A lock is stale only when every process it recorded is dead. We NEVER remove
// a lock whose processes are alive — that would orphan running services.
export function lockIsStale(lock: LocalLock | null): boolean {
  if (!lock) return true;
  return !pidAlive(lock.supervisorPid) && !pidAlive(lock.webPid) && !pidAlive(lock.workerPid);
}

// Confirms the server on the port is OUR healthy Internship Pilot, using the
// versioned extension-health endpoint (never assumes based on the port alone).
export async function serverHealth(): Promise<{ healthy: boolean; body: Record<string, unknown> | null }> {
  try {
    const res = await fetch(`${BASE_URL}/api/extension/health`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { healthy: false, body: null };
    const body = (await res.json()) as Record<string, unknown>;
    const healthy = body?.service != null && String(body.service).toLowerCase().includes("internship");
    return { healthy, body };
  } catch {
    return { healthy: false, body: null };
  }
}

export async function waitForHealthy(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await serverHealth()).healthy) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export function databasePath(): string {
  const url = process.env.DATABASE_URL ?? "file:./dev.db";
  const rel = url.replace(/^file:/, "");
  // The libsql datasource resolves file: URLs relative to the working
  // directory (repo root), where dev.db actually lives.
  return path.isAbsolute(rel) ? rel : path.join(REPO_ROOT, rel.replace(/^\.\//, ""));
}
