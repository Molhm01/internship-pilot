import { createConnection } from "node:net";
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

// Canonical named Prisma Dev instance. We intentionally do NOT hard-code its
// TCP ports: Prisma Dev may reuse an existing named instance or select another
// free port when defaults are occupied. `npm run local` reads the connection
// URL Prisma actually reports and injects that URL into the app process.
export const LOCAL_PRISMA_NAME = "internship-pilot";

const LOCK_DIR = path.join(REPO_ROOT, ".internship-pilot");
const LOCK_FILE = path.join(LOCK_DIR, "local.json");

export type LocalLock = {
  repoRoot: string;
  port: number;
  startedAt: string;
  supervisorPid: number;
  webPid: number | null;
  schedulerPid?: number | null;
  workerPid: number | null;
  databaseDisplay?: string;
};

export function portInUse(port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ host: "localhost", port });

    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
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
  return !pidAlive(lock.supervisorPid)
    && !pidAlive(lock.webPid)
    && !pidAlive(lock.schedulerPid)
    && !pidAlive(lock.workerPid);
}

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

// Redacted display only. Never print credentials into the terminal/status UI.
export function databasePath(url = process.env.DATABASE_URL): string {
  if (!url) return "Local Prisma Postgres (URL injected by npm run local)";
  if (/^postgres(?:ql)?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
    } catch {
      return "PostgreSQL (connection URL configured)";
    }
  }

  const rel = url.replace(/^file:/, "");
  return path.isAbsolute(rel) ? rel : path.join(REPO_ROOT, rel.replace(/^\.\//, ""));
}
