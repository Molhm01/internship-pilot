// Vercel build entrypoint (see package.json "vercel-build" + vercel.json buildCommand).
// Runs `prisma migrate deploy` only for production deployments, before `next build`.
import { spawnSync } from "node:child_process";

const npxCommand = "npx";

function run(command, args) {
  console.log(`[vercel-build] running: ${command} ${args.join(" ")}`);
  // All args below are static literals (never user input), so shell:true here carries no injection risk.
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`[vercel-build] failed to start: ${command}`, result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[vercel-build] command failed with exit code ${result.status}: ${command} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

const vercelEnv = process.env.VERCEL_ENV ?? "development";
console.log(`[vercel-build] VERCEL_ENV=${vercelEnv}`);

run(npxCommand, ["prisma", "generate"]);

if (vercelEnv === "production") {
  console.log("[vercel-build] production deployment detected: running prisma migrate deploy");
  run(npxCommand, ["prisma", "migrate", "deploy"]);
} else {
  console.log(`[vercel-build] ${vercelEnv} deployment: skipping prisma migrate deploy`);
}

run(npxCommand, ["next", "build"]);
