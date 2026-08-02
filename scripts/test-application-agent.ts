import "dotenv/config";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createClient } from "@libsql/client";

const productionDbUrl = process.env.DATABASE_URL ?? "file:./dev.db";

async function productionSnapshot(): Promise<string> {
  const client = createClient({ url: productionDbUrl, timeout: 15_000 });
  const tables = ["ApplicationProfile", "ResumeFact", "ResumeBullet", "ResumeDocument", "ApprovedAnswer", "GeneratedDocument"];
  const snapshot: Record<string, unknown[]> = {};
  try {
    for (const table of tables) {
      const result = await client.execute(`SELECT * FROM "${table}" ORDER BY rowid`);
      snapshot[table] = result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value])));
    }
  } finally {
    client.close();
  }
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${label} exited with code ${code}.`)));
  });
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await fetch(url).then((response) => response.ok).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Isolated test server did not become ready at ${url}.`);
}

async function main(): Promise<void> {
  const before = await productionSnapshot();
  const testRoot = path.join(process.cwd(), "data", "test-runs");
  await mkdir(testRoot, { recursive: true });
  const tempRoot = await mkdtemp(path.join(testRoot, "agent-"));
  const tempName = path.basename(tempRoot);
  if (!/^agent-[A-Za-z0-9]+$/.test(tempName)) throw new Error("Unexpected temporary test directory name.");
  // Prisma's Windows SQLite migration engine rejects nested database paths, so
  // use a uniquely-named disposable DB at the workspace root. It is still
  // isolated from dev.db and is removed in finally after the production hash check.
  const databaseFilename = `test-application-agent-${tempName}.db`;
  const databaseAbsolute = path.join(process.cwd(), databaseFilename);
  const port = 31_000 + (process.pid % 1_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const isolatedEnv = {
    ...process.env,
    DATABASE_URL: `file:./${databaseFilename}`,
    BASE_URL: baseUrl,
    ISOLATED_TEST_MODE: "1",
    TEST_TEMP_ROOT: tempRoot,
    GENERATED_OUTPUT_DIR: path.join(tempRoot, "documents"),
    APPLICATION_OUTPUT_DIR: path.join(tempRoot, "application-runs"),
    APPLICATION_BROWSER_PROFILE_DIR: path.join(tempRoot, "browser-profile"),
    APPLICATION_WORKER_LOCK_PATH: path.join(tempRoot, "application-worker.lock.json"),
    DISABLE_VISION_AGENT: "1",
    FORCE_HEADLESS: "1",
  };

  let server: ReturnType<typeof spawn> | null = null;
  try {
    // Prisma 7's Windows SQLite engine fails to initialize a missing file at
    // this dynamically-generated path; an empty file is a valid SQLite seed.
    await writeFile(databaseAbsolute, "", { flag: "wx" });
    await run(process.execPath, [path.join(process.cwd(), "node_modules", "prisma", "build", "index.js"), "migrate", "deploy"], isolatedEnv, "temporary database migration");
    server = spawn(process.execPath, [path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)], { cwd: process.cwd(), env: isolatedEnv, stdio: "inherit", windowsHide: true });
    await waitForServer(`${baseUrl}/api/agent-diagnostics`);
    await run(process.execPath, ["--import", "tsx", "scripts/test-application-agent-isolated.ts"], isolatedEnv, "isolated application-agent suite");
  } finally {
    if (server && server.exitCode === null) server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const resolvedTemp = path.resolve(tempRoot);
    if (resolvedTemp.startsWith(path.resolve(testRoot)) && path.basename(resolvedTemp).startsWith("agent-")) {
      await rm(resolvedTemp, { recursive: true, force: true });
    }
    await Promise.all([
      rm(databaseAbsolute, { force: true }),
      rm(`${databaseAbsolute}-journal`, { force: true }),
      rm(`${databaseAbsolute}-wal`, { force: true }),
      rm(`${databaseAbsolute}-shm`, { force: true }),
    ]);
  }

  const after = await productionSnapshot();
  if (before !== after) throw new Error("FAIL: isolated mock tests changed production profile, resume evidence, approved answers, or generated documents.");
  console.log("  PASS: production profile, resume evidence, approved answers, and generated documents were unchanged.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
