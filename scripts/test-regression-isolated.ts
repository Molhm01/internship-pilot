import "dotenv/config";
import path from "node:path";
import { spawn } from "node:child_process";

const defaultScripts = [
  "test-db.ts",
  "test-csv-loader.ts",
  "test-fraud-detection.ts",
  "test-strict-discovery-boundary.ts",
  "test-active-jobs-policy.ts",
  "test-verification-model.ts",
  "test-document-strategy.ts",
  "test-scoring-queue.ts",
  "test-discovery-score-integration.ts",
  "test-local-firms.ts",
  "test-gmail-tracking.ts",
  "test-application-multi-user-isolation.ts",
];

const requestedScripts = process.argv.slice(2);
const scripts = requestedScripts.length ? requestedScripts : defaultScripts;

function assertSafePostgresDatabase(): string {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) throw new Error("DATABASE_URL is required for the isolated regression runner.");

  const url = new URL(raw);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("The regression runner is PostgreSQL-only. SQLite/libSQL is no longer a supported test backend.");
  }
  const databaseName = url.pathname.replace(/^\//, "");
  const explicitlyIsolated = process.env.ISOLATED_TEST_MODE === "1";
  const obviouslyTestDb = /(?:audit|test)/i.test(databaseName);
  if (!explicitlyIsolated && !obviouslyTestDb) {
    throw new Error(
      `Refusing to run destructive regression fixtures against database "${databaseName}". ` +
      "Use a database whose name contains test/audit, or set ISOLATED_TEST_MODE=1 only after pointing DATABASE_URL at a disposable database.",
    );
  }
  return databaseName;
}

async function runScript(script: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join("scripts", script)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CI: process.env.CI ?? "true",
          DISABLE_VISION_AGENT: "1",
          ISOLATED_TEST_MODE: "1",
        },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code ?? 1}.`));
    });
  });
}

async function main(): Promise<void> {
  const databaseName = assertSafePostgresDatabase();
  console.log(`Running ${scripts.length} deterministic regression contract(s) against disposable PostgreSQL database "${databaseName}".`);

  const failures: string[] = [];
  for (const script of scripts) {
    console.log(`\n=== PostgreSQL regression: ${script} ===`);
    try {
      await runScript(script);
    } catch (error) {
      failures.push(`${script}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length) {
    throw new Error(`${failures.length} regression contract(s) failed:\n${failures.join("\n")}`);
  }
  console.log(`\nAll ${scripts.length} deterministic PostgreSQL regression contracts PASSED.`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
