import "dotenv/config";
import path from "node:path";
import { copyFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

function productionDatabasePath(): string {
  const url = process.env.DATABASE_URL ?? "file:./dev.db";
  if (!url.startsWith("file:")) throw new Error("Legacy-copy regression requires the local SQLite production database.");
  return path.resolve(process.cwd(), url.slice("file:".length));
}

async function runChild(databaseFilename: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/test-application-legacy-copy-isolated.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: `file:./${databaseFilename}`, LEGACY_COPY_TEST: "1", DISABLE_VISION_AGENT: "1" },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Legacy-copy regression exited with code ${code}.`)));
  });
}

async function main() {
  const databaseFilename = `test-legacy-application-${process.pid}.db`;
  const databasePath = path.join(process.cwd(), databaseFilename);
  await copyFile(productionDatabasePath(), databasePath);
  try {
    await runChild(databaseFilename);
  } finally {
    await Promise.all([
      rm(databasePath, { force: true }),
      rm(`${databasePath}-journal`, { force: true }),
      rm(`${databasePath}-wal`, { force: true }),
      rm(`${databasePath}-shm`, { force: true }),
    ]);
  }
  console.log("  PASS: production-like validation used a disposable copy of the real database; dev.db was not modified.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
