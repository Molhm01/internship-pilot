import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";

export interface ApplicationWorkerLockData {
  pid: number;
  port: number;
  token: string;
  profilePath: string;
  startedAt: string;
  heartbeatAt: string;
  browserReady: boolean;
  extensionReady: boolean;
  extensionId: string | null;
  browserHealth: "healthy" | "unhealthy" | "restarting" | "stopped";
  browserHealthReason: string | null;
  browserGeneration: number;
  extensionFingerprint: string | null;
  browserOpenPages: number;
  processingRunId: string | null;
}

export class DuplicateApplicationWorkerError extends Error {
  constructor(public readonly existing: ApplicationWorkerLockData | null) {
    super(existing
      ? `Application worker already running (PID ${existing.pid}, port ${existing.port}).`
      : "Application worker lock is held by another process.");
  }
}

export function workerLockPath(): string {
  return path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    process.env.APPLICATION_WORKER_LOCK_PATH ?? "data/application-worker.lock.json",
  );
}

export function workerPort(): number {
  const parsed = Number(process.env.APPLICATION_WORKER_PORT ?? "43127");
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 43127;
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

export async function readWorkerLock(): Promise<ApplicationWorkerLockData | null> {
  try {
    const parsed = JSON.parse(await readFile(workerLockPath(), "utf8")) as ApplicationWorkerLockData;
    return parsed && Number.isInteger(parsed.pid) && Number.isInteger(parsed.port) && typeof parsed.token === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function acquireApplicationWorkerLock(profilePath: string): Promise<ApplicationWorkerLock> {
  const lockPath = workerLockPath();
  await mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      const now = new Date().toISOString();
      const data: ApplicationWorkerLockData = {
        pid: process.pid,
        port: workerPort(),
        token: randomUUID(),
        profilePath,
        startedAt: now,
        heartbeatAt: now,
        browserReady: false,
        extensionReady: false,
        extensionId: null,
        browserHealth: "unhealthy",
        browserHealthReason: "The worker-owned browser has not started.",
        browserGeneration: 0,
        extensionFingerprint: null,
        browserOpenPages: 0,
        processingRunId: null,
      };
      await handle.writeFile(JSON.stringify(data, null, 2));
      await handle.close();
      return new ApplicationWorkerLock(lockPath, data);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      const existing = await readWorkerLock();
      if (existing) {
        const processRunning = isProcessRunning(existing.pid);
        const health = processRunning ? await fetchWorkerHealth(existing) : null;
        const heartbeatAgeMs = Date.now() - new Date(existing.heartbeatAt).getTime();
        const isStale = !processRunning || (!health && heartbeatAgeMs > 10_000);
        if (!isStale) {
          throw new DuplicateApplicationWorkerError(existing);
        }
        if (processRunning && !health) {
          try { process.kill(existing.pid, "SIGTERM"); } catch {}
        }
      }
      await unlink(lockPath).catch((unlinkError) => {
        if (!(unlinkError && typeof unlinkError === "object" && "code" in unlinkError && unlinkError.code === "ENOENT")) throw unlinkError;
      });
    }
  }
  throw new DuplicateApplicationWorkerError(await readWorkerLock());
}

export class ApplicationWorkerLock {
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly lockPath: string, private data: ApplicationWorkerLockData) {}

  snapshot(): ApplicationWorkerLockData {
    return { ...this.data };
  }

  async update(patch: Partial<Pick<
    ApplicationWorkerLockData,
    | "browserReady"
    | "extensionReady"
    | "extensionId"
    | "browserHealth"
    | "browserHealthReason"
    | "browserGeneration"
    | "extensionFingerprint"
    | "browserOpenPages"
    | "processingRunId"
  >> = {}): Promise<void> {
    this.data = { ...this.data, ...patch, heartbeatAt: new Date().toISOString() };
    await writeFile(this.lockPath, JSON.stringify(this.data, null, 2), "utf8");
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => void this.update().catch(() => {}), 2_000);
    this.heartbeatTimer.unref();
  }

  async release(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const current = await readWorkerLock();
    if (current?.token === this.data.token && current.pid === process.pid) await unlink(this.lockPath).catch(() => {});
  }
}

export async function fetchWorkerHealth(lock: ApplicationWorkerLockData): Promise<ApplicationWorkerLockData | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${lock.port}/health`, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return null;
    const health = await response.json() as ApplicationWorkerLockData;
    return health.token === lock.token && health.pid === lock.pid ? health : null;
  } catch {
    return null;
  }
}
