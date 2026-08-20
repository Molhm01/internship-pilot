import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const isProductionVercel = process.env.VERCEL === "1" && process.env.VERCEL_ENV === "production";

if (isProductionVercel) {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error("[vercel-build] DATABASE_URL is required for a production deployment. Refusing to promote code without verifying database migrations.");
    process.exit(1);
  }

  console.log("[vercel-build] Applying pending production database migrations before Next.js build...");
  run("npx", ["prisma", "migrate", "deploy"]);
  console.log("[vercel-build] Production database migrations are current.");
} else {
  console.log(`[vercel-build] Skipping database migration for VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}.`);
}

run("npm", ["run", "build"]);
