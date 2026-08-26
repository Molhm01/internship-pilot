import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Internship Pilot runs locally as three independent processes:
 *
 *   1. the Next.js website
 *   2. the radar + ATS scheduler/scoring worker
 *   3. the application/browser worker
 *
 * They were one process until pg's Node built-ins broke the Windows Webpack
 * build. These checks hold the split in place: the workers must stay startable
 * without Next, the supervisor must actually start all three, stop and status
 * must know about all three, and a dead background worker must not take the
 * website down with it.
 */

const REPO_ROOT = process.cwd();

function script(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

const packageJson = JSON.parse(script("package.json")) as { scripts: Record<string, string> };

describe("the scheduler worker is a standalone Node entrypoint", () => {
  const source = script("scripts/scheduler-worker.ts");

  it("starts the scheduler itself", () => {
    expect(source).toContain('from "@/lib/sync/scheduler"');
    expect(source).toContain("startScheduler({ scoringEnabled })");
  });

  it("does not require Next.js", () => {
    // Anything importing Next would put this back inside the bundler's graph,
    // which is the whole reason it became a separate process.
    expect(source).not.toMatch(/from\s+["']next(\/|["'])/);
    expect(source).not.toMatch(/require\(["']next(\/|["'])/);
  });

  it("inherits DATABASE_URL and OLLAMA_MODEL from the supervisor", () => {
    // dotenv/config fills gaps but never overwrites an inherited variable, so
    // the URL npm run local got from Prisma Dev and the model tag that is
    // really installed both survive into this process.
    expect(source).toContain('import "dotenv/config"');
    expect(source).toContain("process.env.DATABASE_URL");
    expect(source).toContain("process.env.OLLAMA_MODEL");
    // It must refuse to run against an unknown database rather than silently
    // scheduling work somewhere else.
    expect(source).toMatch(/if \(!process\.env\.DATABASE_URL\)[\s\S]{0,400}process\.exit\(1\)/);
  });

  it("shuts down cleanly on SIGINT and SIGTERM", () => {
    expect(source).toMatch(/process\.once\(\s*"SIGINT"/);
    expect(source).toMatch(/process\.once\(\s*"SIGTERM"/);
    expect(source).toContain("prisma.$disconnect()");
  });
});

describe("the local supervisor runs exactly three processes", () => {
  const source = script("scripts/local.ts");

  it("starts the website, the scheduler worker, and the application worker", () => {
    expect(source).toContain("nextCli");
    expect(source).toContain("scripts/scheduler-worker.ts");
    expect(source).toContain("scripts/application-worker.ts");
  });

  it("starts no other long-lived child process", () => {
    const spawned = [...source.matchAll(/"scripts\/([a-z0-9-]+)\.ts"/g)].map((match) => match[1]);
    // test-db.ts is a one-shot verification step, not a supervised service.
    const services = spawned.filter((name) => name !== "test-db");
    expect(new Set(services)).toEqual(new Set(["scheduler-worker", "application-worker"]));
  });

  it("never starts the scheduler inside the web process", () => {
    expect(source).not.toContain("@/lib/sync/scheduler");
    expect(script("package.json")).not.toMatch(/instrumentation/);
  });
});

describe("a background worker crash does not take the website down", () => {
  it("keeps the website up when the local scheduler gives up", () => {
    const source = script("scripts/local.ts");
    const handler = source.slice(
      source.indexOf("const startScheduler = ()"),
      source.indexOf("const startWorker = ()"),
    );

    expect(handler.length).toBeGreaterThan(0);
    expect(handler).toContain("MAX_SCHEDULER_RESTARTS");
    expect(handler, "an exhausted scheduler must not shut down the service group").not.toContain("shutdown(");
  });

  it("keeps the website up when the application worker gives up", () => {
    const source = script("scripts/local.ts");
    const handler = source.slice(source.indexOf("const startWorker = ()"));
    const untilNextBlock = handler.slice(0, handler.indexOf("log(`Starting web server"));

    expect(untilNextBlock.length).toBeGreaterThan(0);
    expect(untilNextBlock).toContain("MAX_WORKER_RESTARTS");
    expect(untilNextBlock, "an exhausted application worker must not shut down the service group").not.toContain("shutdown(");
  });

  it("still stops everything when the website itself cannot stay up", () => {
    // The opposite failure matters too: without a website there is no product,
    // so that one really should tear the group down instead of idling.
    const source = script("scripts/local.ts");
    const handler = source.slice(
      source.indexOf("const startWeb = ()"),
      source.indexOf("const startScheduler = ()"),
    );

    expect(handler).toContain("void shutdown(");
  });

  it("treats only the web server as critical in scripts/start-all.ts", () => {
    const source = script("scripts/start-all.ts");

    expect(source).toMatch(/start\("web server",[\s\S]{0,200}critical: true/);
    expect(source).toMatch(/start\("scheduler \+ scoring worker",[\s\S]{0,200}critical: false/);
    expect(source).toMatch(/start\("application worker",[\s\S]{0,200}critical: false/);
  });
});

describe("stop and status understand all three processes", () => {
  it("records a PID for each supervised process", () => {
    const shared = script("scripts/local-shared.ts");
    for (const field of ["webPid", "schedulerPid", "workerPid"]) {
      expect(shared, `LocalLock must carry ${field}`).toContain(field);
    }
    // A lock is only stale when every recorded process is dead — including the
    // scheduler, or local:stop would drop a live worker from the lockfile.
    const stale = shared.slice(shared.indexOf("export function lockIsStale"));
    expect(stale).toContain("schedulerPid");
  });

  it("stops the scheduler as well as the web server and the browser worker", () => {
    const source = script("scripts/local-stop.ts");
    expect(source).toContain("lock.schedulerPid");
    expect(source).toContain("lock.workerPid");
    expect(source).toContain("lock.webPid");
    // Only PIDs this repository recorded are ever stopped.
    expect(source).toContain("lock.repoRoot !== REPO_ROOT");
  });

  it("reports the scheduler as well as the web server and the browser worker", () => {
    const source = script("scripts/local-status.ts");
    expect(source).toContain("schedulerPid");
    expect(source).toContain("workerPid");
    expect(source).toContain("Website");
  });

  it("wires all three commands to the supervisor scripts", () => {
    expect(packageJson.scripts.local).toContain("local-entry.ts");
    expect(packageJson.scripts["local:stop"]).toContain("local-stop.ts");
    expect(packageJson.scripts["local:status"]).toContain("local-status.ts");
  });
});
