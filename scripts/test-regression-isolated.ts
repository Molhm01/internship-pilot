import "dotenv/config";
import path from "node:path";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createClient } from "@libsql/client";

const defaultScripts = [
  "test-db.ts",
  "test-job-scoring.ts",
  "test-resume-parsing.ts",
  "test-pdf-upload.ts",
  "test-sync.ts",
  "test-verification.ts",
  "test-filters-and-scoring.ts",
  "test-nationwide.ts",
  "test-nearby.ts",
  "test-strict-verification.ts",
  "test-scheduler.ts",
  "test-documents.ts",
  "test-gmail-tracking.ts",
  "test-csv-loader.ts",
  "test-fraud-detection.ts",
  "test-strict-discovery-boundary.ts",
];
const requestedScripts = process.argv.slice(2);
const scripts = requestedScripts.length ? requestedScripts : defaultScripts;

function productionDatabasePath(): string {
  const url = process.env.DATABASE_URL ?? "file:./dev.db";
  if (!url.startsWith("file:")) throw new Error("The isolated regression runner requires the local SQLite database.");
  return path.resolve(process.cwd(), url.slice("file:".length));
}

async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code ?? 1}.`));
    });
  });
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await fetch(url).then((response) => response.ok).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Isolated regression server did not become ready at ${url}.`);
}

async function stop(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

async function removeDatabaseFiles(databasePath: string): Promise<void> {
  const targets = [databasePath, `${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await Promise.all(targets.map((target) => rm(target, { force: true })));
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

async function main(): Promise<void> {
  const root = path.resolve(process.cwd(), "data", "test-runs");
  await mkdir(root, { recursive: true });
  const tempRoot = await mkdtemp(path.join(root, "regression-"));
  const databaseFilename = `test-regression-${path.basename(tempRoot)}.db`;
  const databasePath = path.resolve(process.cwd(), databaseFilename);
  const port = 32_000 + (process.pid % 1_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  await copyFile(productionDatabasePath(), databasePath);
  const copiedDatabase = createClient({ url: `file:${databasePath}`, timeout: 15_000 });
  try {
    await copiedDatabase.execute({
      sql: `INSERT INTO "AppSetting" ("key", "value", "updatedAt")
            VALUES ('schedulerPaused', 'true', datetime('now'))
            ON CONFLICT("key") DO UPDATE SET "value" = 'true', "updatedAt" = datetime('now')`,
      args: [],
    });
  } finally {
    copiedDatabase.close();
  }

  const env = {
    ...process.env,
    DATABASE_URL: `file:./${databaseFilename}`,
    BASE_URL: baseUrl,
    ISOLATED_TEST_MODE: "1",
    TEST_TEMP_ROOT: tempRoot,
    RESUME_STORAGE_DIR: path.join(tempRoot, "resumes"),
    GENERATED_OUTPUT_DIR: path.join(tempRoot, "generated"),
    APPLICATION_OUTPUT_DIR: path.join(tempRoot, "application-runs"),
    APPLICATION_BROWSER_PROFILE_DIR: path.join(tempRoot, "browser-profile"),
    APPLICATION_WORKER_LOCK_PATH: path.join(tempRoot, "application-worker.lock.json"),
    DISABLE_VISION_AGENT: "1",
  };

  let server: ChildProcess | null = null;
  const failures: string[] = [];
  try {
    server = spawn(
      process.execPath,
      [path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)],
      { cwd: process.cwd(), env, stdio: "inherit", windowsHide: true },
    );
    await waitForServer(`${baseUrl}/api/agent-diagnostics`);
    for (const script of scripts) {
      console.log(`\n=== Isolated regression: ${script} ===`);
      try {
        await run(process.execPath, ["--import", "tsx", path.join("scripts", script)], env, script);
      } catch (error) {
        failures.push(`${script}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length) {
      throw new Error(`${failures.length} isolated regression script(s) failed:\n${failures.join("\n")}`);
    }
    console.log(`\nAll ${scripts.length} existing regression scripts PASSED in an isolated database and output directory.`);
  } finally {
    await stop(server);
    const resolved = path.resolve(tempRoot);
    if (resolved.startsWith(root) && path.basename(resolved).startsWith("regression-")) {
      await rm(resolved, { recursive: true, force: true });
    }
    await removeDatabaseFiles(databasePath);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
