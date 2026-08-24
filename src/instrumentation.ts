/**
 * Next instrumentation intentionally does NOT start the long-lived local
 * scheduler. Importing the scheduler here pulls PostgreSQL/Prisma and every
 * discovery dependency into Next's instrumentation bundle. On Windows Webpack
 * that caused Node built-ins such as `fs` and `path` (via pg/pgpass) to be
 * resolved as browser modules and prevented the entire website from compiling.
 *
 * `npm run local` and `scripts/start-all.ts` now supervise the scheduler as its
 * own Node process (`scripts/scheduler-worker.ts`). Hosted deployments should
 * use platform cron/trigger routes for recurring work instead of an in-process
 * timer.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.INTERNSHIP_PILOT_RUNTIME === "local") {
    console.info("[scheduler] Managed by the standalone local scheduler process.");
  }
}
