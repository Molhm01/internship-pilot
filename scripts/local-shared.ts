import { createConnection } from "node:net";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  hashRepoRoot,
  readGitCommit,
  LOCAL_INSTANCE_PROTOCOL,
  type InstanceExpectation,
  type LocalInstanceIdentity,
} from "@/lib/runtime/localInstance";
import {
  extractDocumentAssets,
  summarizeAssetHealth,
  type AssetHealthReport,
  type AssetProbeResult,
} from "@/lib/runtime/documentAssets";

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

// ---------------------------------------------------------------------------
// Instance identity and real asset health
// ---------------------------------------------------------------------------

/** What THIS checkout expects a reusable server to say about itself. */
export function expectedInstance(): InstanceExpectation & { repoRoot: string } {
  const { commit } = readGitCommit(REPO_ROOT);
  let buildId: string | null = null;
  try {
    const file = path.join(REPO_ROOT, ".next", "BUILD_ID");
    buildId = existsSync(file) ? readFileSync(file, "utf8").trim() || null : null;
  } catch {
    buildId = null;
  }
  return {
    repoRoot: REPO_ROOT,
    repoRootHash: hashRepoRoot(REPO_ROOT),
    commit,
    buildId,
    instanceProtocol: LOCAL_INSTANCE_PROTOCOL,
  };
}

/** Asks the process on the port which checkout and build it came from. */
export async function fetchRunningInstance(baseUrl = BASE_URL): Promise<LocalInstanceIdentity | null> {
  try {
    const res = await fetch(`${baseUrl}/api/local/instance`, {
      signal: AbortSignal.timeout(4000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<LocalInstanceIdentity>;
    if (body?.service !== "Internship Pilot" || typeof body.repoRootHash !== "string") return null;
    return body as LocalInstanceIdentity;
  } catch {
    return null;
  }
}

/**
 * Fetches a document and then every same-origin script/stylesheet it points
 * at. This is the check that a stale Next process fails: it still answers the
 * route, but its `_next/static` chunks are gone.
 */
export async function checkAssetHealth(
  route = "/",
  baseUrl = BASE_URL,
  options: { maxAssets?: number; timeoutMs?: number } = {},
): Promise<AssetHealthReport> {
  const maxAssets = options.maxAssets ?? 40;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const documentUrl = `${baseUrl}${route}`;

  let documentStatus: number | null = null;
  let html = "";
  try {
    const res = await fetch(documentUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "text/html" },
      redirect: "follow",
    });
    documentStatus = res.status;
    html = await res.text();
  } catch {
    return summarizeAssetHealth({ documentStatus: null, documentBytes: 0, probes: [], requireAssets: true });
  }

  const assets = extractDocumentAssets(html, documentUrl).slice(0, maxAssets);
  const probes: AssetProbeResult[] = await Promise.all(
    assets.map(async (asset) => {
      try {
        const res = await fetch(asset.url, { signal: AbortSignal.timeout(timeoutMs) });
        // Drain so the connection is released rather than left half-open.
        await res.arrayBuffer().catch(() => undefined);
        return { ...asset, status: res.status };
      } catch (error) {
        return { ...asset, status: null, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );

  return summarizeAssetHealth({
    documentStatus,
    documentBytes: html.length,
    probes,
    requireAssets: true,
  });
}

export type { AssetHealthReport, LocalInstanceIdentity };

/**
 * Stops one process tree. Only ever called with a PID that has already been
 * proven to belong to this repository — never with a PID merely observed on
 * the port.
 */
export function stopProcessTree(pid: number): boolean {
  if (!pidAlive(pid)) return false;
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${pid} /t /f`, { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export async function waitForPortFree(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portInUse(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return !(await portInUse(port));
}

/**
 * Health, identity and asset integrity in one call — the complete answer to
 * "is the thing on this port a server I can actually use?".
 */
export async function probeRunningServer(baseUrl = BASE_URL): Promise<{
  healthOk: boolean;
  runningInstance: LocalInstanceIdentity | null;
  assetHealth: AssetHealthReport | null;
}> {
  const [health, runningInstance] = await Promise.all([serverHealth(), fetchRunningInstance(baseUrl)]);
  // Asset integrity is only meaningful once something is answering at all.
  const assetHealth = health.healthy || runningInstance ? await checkAssetHealth("/", baseUrl) : null;
  return { healthOk: health.healthy, runningInstance, assetHealth };
}
