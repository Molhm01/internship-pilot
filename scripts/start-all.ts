import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

const production = process.argv.includes("--production");
const nextCli = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const webPort = Number(process.env.PORT ?? 3000);
const children: ChildProcess[] = [];
let stopping = false;

// The extension is configured to talk to a fixed local address, so we must
// NOT silently fall back to another port. Instead, detect an occupied port
// up front and explain exactly what to do — never crash with a raw
// EADDRINUSE, and never kill unrelated processes automatically.
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
  } catch {
    // Diagnostics are best-effort; fall through to the generic message.
  }
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
      "This is almost always a previous Internship Pilot web server that is still running.",
      "Stop only that process, then start again — for example:",
      process.platform === "win32"
        ? `    Get-NetTCPConnection -LocalPort ${webPort} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess }`
        : `    lsof -ti tcp:${webPort} -sTCP:LISTEN | xargs kill`,
      "",
      "Do NOT kill unrelated Node apps. Internship Pilot will not switch ports,",
      `because the Chrome extension is configured to talk to http://localhost:${webPort}.`,
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function start(label: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
    windowsHide: true,
  });
  children.push(child);
  child.once("exit", (code, signal) => {
    if (stopping) return;
    console.error(`${label} stopped unexpectedly (${signal ?? `exit ${code ?? 1}`}). Stopping the service group.`);
    void shutdown(code ?? 1);
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

// Next's instrumentation hook starts the scheduler. This supervisor starts
// that web process and exactly one standalone application worker together.
async function main(): Promise<void> {
  await ensurePortFree();
  start("web server + scheduler", [nextCli, production ? "start" : "dev"]);
  start("application worker", ["--import", "tsx", "scripts/application-worker.ts"]);
}

void main();
