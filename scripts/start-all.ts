import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

const production = process.argv.includes("--production");
const nextCli = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const webPort = Number(process.env.PORT ?? 3000);
const children: ChildProcess[] = [];
let stopping = false;

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createServer()
      .once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EADDRINUSE"))
      .once("listening", () => tester.close(() => resolve(false)))
      .listen(port, "0.0.0.0");
  });
}

function describePortOwner(port: number): string {
  try {
    if (process.platform === "win32") {
      const line = execSync(`netstat -ano -p tcp | findstr LISTENING | findstr :${port}`, { encoding: "utf8" })
        .split(/\r?\n/).find(Boolean) ?? "";
      const pid = line.trim().split(/\s+/).pop();
      if (pid) {
        let name = "unknown";
        try {
          name = execSync(`tasklist /fi "PID eq ${pid}" /nh /fo csv`, { encoding: "utf8" }).split(",")[0]?.replace(/"/g, "") ?? "unknown";
        } catch { /* leave as unknown */ }
        return `process ${name} (PID ${pid})`;
      }
    } else {
      const pid = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: "utf8" }).split(/\r?\n/).find(Boolean);
      if (pid) return `PID ${pid}`;
    }
  } catch {}
  return "another process";
}

async function ensurePortFree(): Promise<void> {
  if (!(await portInUse(webPort))) return;
  const owner = describePortOwner(webPort);
  console.error(
    [
      "",
      `✗ Cannot start: port ${webPort} is already in use by ${owner}.`,
      "",
      "Stop that process, then start again. Internship Pilot will not switch ports,",
      `because the Chrome extension is configured to talk to http://localhost:${webPort}.`,
      "",
    ].join("\n"),
  );
  process.exit(1);
}

// `critical: true` means the service group cannot serve the product without
// this process. Only the web server qualifies: the scheduler and the browser
// worker are background capabilities, and taking the website down with them
// would turn a degraded install into a total outage.
function start(
  label: string,
  args: string[],
  options: { critical: boolean; degradedNote: string },
  extraEnv: Record<string, string | undefined> = {},
): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
    windowsHide: true,
  });
  children.push(child);
  child.once("exit", (code, signal) => {
    if (stopping) return;
    const how = signal ?? `exit ${code ?? 1}`;
    if (options.critical) {
      console.error(`${label} stopped unexpectedly (${how}). Stopping the service group.`);
      void shutdown(code ?? 1);
      return;
    }
    console.error(`${label} stopped unexpectedly (${how}). ${options.degradedNote}`);
  });
  return child;
}

async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(children.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    setTimeout(resolve, 5_000).unref();
  })));
  process.exit(code);
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

// Keep server-only discovery/Prisma code out of Next's instrumentation bundle.
// The web server, durable scheduler/scoring worker, and browser worker are three
// sibling Node processes supervised as one service group.
async function main(): Promise<void> {
  await ensurePortFree();
  start("web server", [nextCli, production ? "start" : "dev"], {
    critical: true,
    degradedNote: "",
  });
  start("scheduler + scoring worker", ["--import", "tsx", "scripts/scheduler-worker.ts"], {
    critical: false,
    degradedNote: "The website stays up WITHOUT radar discovery or ATS scoring; queued work is durable in PostgreSQL and resumes on the next start.",
  });
  start("application worker", ["--import", "tsx", "scripts/application-worker.ts"], {
    critical: false,
    degradedNote: "The website stays up WITHOUT browser autofill. Existing application runs are unaffected.",
  });
}

void main();
