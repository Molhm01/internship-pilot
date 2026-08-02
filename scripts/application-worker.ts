import "dotenv/config";
import { createServer, type Server } from "node:http";
import { prisma } from "@/lib/db";
import { applicationProfilePath } from "@/lib/applications/browserProfile";
import { BrowserManager } from "@/lib/applications/browserManager";
import { getOrCreateExtensionApiToken } from "@/lib/applications/extensionAuth";
import { processApplicationRun } from "@/lib/applications/worker";
import {
  acquireApplicationWorkerLock,
  DuplicateApplicationWorkerError,
  type ApplicationWorkerLock,
} from "@/lib/applications/workerLock";
import { recordRunStage } from "@/lib/applications/validation";

process.env.APPLICATION_WORKER_OWNER = "1";

const TEST_SOURCE = "application-worker-test";
const testOnly = process.env.APPLICATION_WORKER_TEST_ONLY === "1";
let stopping = false;
let healthServer: Server | null = null;
let lock: ApplicationWorkerLock | null = null;
let browserManager: BrowserManager | null = null;

function inWorkerScope(source: string | null): boolean {
  return testOnly ? source === TEST_SOURCE : source !== TEST_SOURCE;
}

async function repairDuplicateRuns(): Promise<void> {
  const active = await prisma.applicationRun.findMany({
    where: { status: { in: ["queued", "running", "needs_user_action"] } },
    include: { job: { select: { source: true } } },
    orderBy: { createdAt: "asc" },
  });
  const groups = new Map<string, typeof active>();
  for (const run of active) {
    if (!inWorkerScope(run.job.source)) continue;
    groups.set(run.jobId, [...(groups.get(run.jobId) ?? []), run]);
  }
  for (const [jobId, runs] of groups) {
    const canonical = [...runs].sort(
      (a, b) => Number(Boolean(b.stoppedFieldLabel)) - Number(Boolean(a.stoppedFieldLabel)) || a.createdAt.getTime() - b.createdAt.getTime(),
    )[0];
    const duplicates = runs.filter((run) => run.id !== canonical.id).map((run) => run.id);
    if (duplicates.length) {
      await prisma.applicationRun.updateMany({
        where: { id: { in: duplicates } },
        data: { activeKey: null, status: "superseded", currentStep: "Superseded duplicate run", finishedAt: new Date() },
      });
    }
    await prisma.applicationRun.update({ where: { id: canonical.id }, data: { activeKey: jobId } });
  }
}

async function recoverInterruptedRuns(): Promise<void> {
  const interrupted = await prisma.applicationRun.findMany({
    where: { status: "running" },
    include: { job: { select: { source: true } } },
  });
  const ids = interrupted.filter((run) => inWorkerScope(run.job.source)).map((run) => run.id);
  if (!ids.length) return;
  await prisma.applicationRun.updateMany({
    where: { id: { in: ids } },
    data: { status: "queued", currentStep: "QUEUED", finishedAt: null },
  });
  for (const id of ids) await recordRunStage(id, "QUEUED", "Recovered after worker restart.");
}

async function nextQueuedRunId(): Promise<string | null> {
  const candidates = await prisma.applicationRun.findMany({
    where: { status: "queued" },
    include: { job: { select: { source: true } } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  return candidates.find((run) => inWorkerScope(run.job.source))?.id ?? null;
}

async function claimRun(runId: string): Promise<boolean> {
  const result = await prisma.applicationRun.updateMany({
    where: { id: runId, status: "queued" },
    data: { status: "running", currentStep: "STARTING_BROWSER", startedAt: new Date(), finishedAt: null },
  });
  if (result.count === 1) await recordRunStage(runId, "STARTING_BROWSER", "Background worker claimed the queued run.");
  return result.count === 1;
}

async function startHealthServer(): Promise<void> {
  if (!lock) throw new Error("Worker lock must be acquired before opening its port.");
  healthServer = createServer((request, response) => {
    if (request.url === "/health" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(lock?.snapshot() ?? null));
      return;
    }
    if (testOnly && request.method === "POST" && request.url === "/test/browser/close") {
      void browserManager?.forceCloseForTest("Test closed Chromium between queued runs.").then(() => {
        response.writeHead(204).end();
      }).catch((error) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
      return;
    }
    if (testOnly && request.method === "POST" && request.url === "/test/browser/close-before-new-page") {
      browserManager?.closeImmediatelyBeforeNextPageForTest();
      response.writeHead(204).end();
      return;
    }
    if (testOnly && request.method === "POST" && request.url === "/test/extension/rebuilt") {
      void browserManager?.simulateExtensionRebuildForTest().then(() => {
        response.writeHead(204).end();
      }).catch((error) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
      return;
    }
    if (testOnly && request.method === "POST" && request.url?.startsWith("/test/captcha/complete")) {
      const runId = new URL(request.url, "http://127.0.0.1").searchParams.get("runId") ?? "";
      void browserManager?.completeLocalCaptchaForTest(runId).then(() => {
        response.writeHead(204).end();
      }).catch((error) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
      return;
    }
    {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    healthServer?.once("error", reject);
    healthServer?.listen(lock?.snapshot().port, "127.0.0.1", () => resolve());
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function shutdown(exitCode = 0): Promise<never> {
  if (!stopping) stopping = true;
  await browserManager?.close();
  await new Promise<void>((resolve) => healthServer?.close(() => resolve()) ?? resolve());
  await lock?.release();
  await prisma.$disconnect();
  process.exit(exitCode);
}

async function main(): Promise<void> {
  try {
    lock = await acquireApplicationWorkerLock(applicationProfilePath());
  } catch (error) {
    if (error instanceof DuplicateApplicationWorkerError) {
      console.error(error.message);
      process.exit(73);
    }
    throw error;
  }

  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
  process.once("SIGHUP", () => void shutdown(0));

  try {
    await startHealthServer();
    lock.startHeartbeat();
    await repairDuplicateRuns();
    await recoverInterruptedRuns();
    const extensionApiToken = await getOrCreateExtensionApiToken();
    browserManager = new BrowserManager(extensionApiToken, async (health) => {
      await lock?.update({
        browserReady: health.state === "healthy",
        extensionReady: health.extensionReady,
        extensionId: health.extensionId,
        browserHealth: health.state,
        browserHealthReason: health.reason,
        browserGeneration: health.generation,
        extensionFingerprint: health.extensionFingerprint,
        browserOpenPages: health.openPages,
      });
    });
    await browserManager.ensureHealthy("worker startup").catch((error) => {
      console.error(`Application browser will retry on the next run: ${error instanceof Error ? error.message : String(error)}`);
    });
    const initialHealth = browserManager.snapshot();
    console.log(`Application worker ready (PID ${process.pid}, port ${lock.snapshot().port}, profile ${applicationProfilePath()}, browser ${initialHealth.state}, extension ${initialHealth.extensionId ?? "not loaded"}).`);

    while (!stopping) {
      try {
        const runId = await nextQueuedRunId();
        if (!runId) {
          await delay(400);
          continue;
        }
        if (!(await claimRun(runId))) continue;
        await lock.update({ processingRunId: runId });
        try {
          await processApplicationRun(runId, browserManager);
        } catch (error) {
          // A transient SQLite timeout must not tear down the browser owner.
          // Requeue the same claimed row and retry after other local work
          // releases the database; never create a replacement run.
          console.error(`Run ${runId} will retry: ${error instanceof Error ? error.message : String(error)}`);
          await prisma.applicationRun.updateMany({
            where: { id: runId, status: "running" },
            data: { status: "queued", currentStep: "QUEUED" },
          }).catch(() => {});
          await recordRunStage(runId, "QUEUED", "Unexpected worker exception; same run will retry without creating a duplicate.").catch(() => {});
          await delay(1_000);
        } finally {
          await lock.update({ processingRunId: null });
        }
      } catch (error) {
        console.error(`Application queue poll will retry: ${error instanceof Error ? error.message : String(error)}`);
        await delay(1_000);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    await shutdown(1);
  }
}

void main();
