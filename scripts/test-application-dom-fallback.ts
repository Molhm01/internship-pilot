import "dotenv/config";
import path from "node:path";
import { copyFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

function productionDatabasePath(): string {
  const url = process.env.DATABASE_URL ?? "file:./dev.db";
  if (!url.startsWith("file:")) throw new Error("DOM fallback regression requires the local SQLite production database.");
  return path.resolve(process.cwd(), url.slice("file:".length));
}

async function main(): Promise<void> {
  const databaseFilename = `test-dom-fallback-${process.pid}.db`;
  const databasePath = path.join(process.cwd(), databaseFilename);
  await copyFile(productionDatabasePath(), databasePath);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/test-application-dom-fallback-isolated.ts"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: `file:./${databaseFilename}`,
          DOM_FALLBACK_COPY_TEST: "1",
          DISABLE_VISION_AGENT: "1",
        },
        stdio: "inherit",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`DOM fallback regression exited with code ${code}.`)));
    });
  } finally {
    await Promise.all([
      rm(databasePath, { force: true }),
      rm(`${databasePath}-journal`, { force: true }),
      rm(`${databasePath}-wal`, { force: true }),
      rm(`${databasePath}-shm`, { force: true }),
    ]);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
