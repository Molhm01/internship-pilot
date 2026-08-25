import "dotenv/config";
import { prisma } from "@/lib/db";
import { startScheduler } from "@/lib/sync/scheduler";
import { isCloudRuntime } from "@/lib/runtime/deployment";

/**
 * Standalone long-lived scheduler process — radar discovery, verification,
 * Gmail tracking, description hydration and ATS scoring.
 *
 * This is deliberately NOT started from Next's instrumentation. Reaching the
 * scheduler from there pulled `@/lib/db` -> @prisma/adapter-pg -> pg -> pgpass
 * into Next's bundle, and Windows Webpack then tried to resolve Node built-ins
 * (`fs`, then `path`) as browser modules, which stopped the entire website from
 * compiling. Nothing here imports Next.
 *
 * All queue and progress state is durable in PostgreSQL, so restarting this
 * process resumes work rather than losing it.
 *
 * Environment is inherited from the supervisor (scripts/local.ts) and only
 * filled in from .env where the parent left a value unset — `dotenv/config`
 * never overwrites an inherited variable. That is what keeps this worker on the
 * exact DATABASE_URL that `npm run local` obtained from Prisma Dev and the
 * exact OLLAMA_MODEL tag that is actually installed on this machine.
 */

if (!process.env.DATABASE_URL) {
  console.error(
    "[scheduler-worker] DATABASE_URL is not set. Start via `npm run local` (which injects the local "
      + "PostgreSQL URL) or export DATABASE_URL before running this worker directly.",
  );
  process.exit(1);
}

/**
 * Hard production guard.
 *
 * This process runs nine independent `setInterval` loops (radar discovery,
 * verification, Gmail tracking, description hydration, ATS scoring, ...) on
 * cadences as tight as every few minutes — deliberately local-only, since
 * GitHub Actions is the single production scheduler (see the DATABASE
 * EFFICIENCY REPAIR report). If this ever ran against the production
 * database it would recreate exactly the duplicate-scheduler problem that
 * report fixes, indefinitely, from a machine nobody is watching.
 *
 * Two independent checks, because either one drifting alone must still stop
 * it: `isCloudRuntime()` (VERCEL=1 or INTERNSHIP_PILOT_RUNTIME=cloud) covers
 * "this is actually a cloud deployment", and the DATABASE_URL host check
 * covers "a local process was accidentally pointed at a hosted database" —
 * the failure mode `npm run local` exists to prevent by always injecting a
 * fresh local Prisma Dev URL, but this worker can also be run directly.
 */
function assertNotProductionDatabase(): void {
  if (isCloudRuntime()) {
    console.error(
      "[scheduler-worker] Refusing to start: this process detected a cloud runtime "
        + "(VERCEL or INTERNSHIP_PILOT_RUNTIME=cloud). The scheduler-worker is local-only — "
        + "GitHub Actions (.github/workflows/live-job-ingestion.yml) is the production scheduler.",
    );
    process.exit(1);
  }

  const raw = process.env.DATABASE_URL ?? "";
  let host = "";
  try {
    // DATABASE_URL may be a non-standard scheme (e.g. prisma+postgres://), which
    // the WHATWG URL parser still handles fine for extracting the host.
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    console.error("[scheduler-worker] Refusing to start: DATABASE_URL could not be parsed.");
    process.exit(1);
  }
  const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "";
  if (!isLocalHost) {
    console.error(
      `[scheduler-worker] Refusing to start: DATABASE_URL host "${host}" is not localhost. `
        + "This worker must only run against the local Prisma Dev database that `npm run local` "
        + "provisions — running it against a remote/production database would recreate the "
        + "duplicate-scheduler problem the hosted GitHub Actions lanes exist to fix alone.",
    );
    process.exit(1);
  }
}

assertNotProductionDatabase();

let stopping = false;

async function stop(reason: string, exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[scheduler-worker] ${reason}; stopping.`);
  // In-flight timers are abandoned on purpose: every unit of scheduler work is
  // a durable PostgreSQL row, so the next start picks it up rather than
  // half-finishing it here while the connection is closing.
  try {
    await prisma.$disconnect();
  } catch {
    // Shutting down anyway — a failed disconnect must not hold the process open.
  }
  process.exit(exitCode);
}

process.once("SIGINT", () => void stop("SIGINT received", 0));
process.once("SIGTERM", () => void stop("SIGTERM received", 0));

// A rejected scheduler tick must not silently kill radar and ATS scoring for
// the rest of the session. Log it and keep the timers running; the supervisor
// restarts the process only if it really exits.
process.on("unhandledRejection", (reason) => {
  console.error(`[scheduler-worker] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

const scoringEnabled = process.env.SCHEDULER_SCORING_ENABLED !== "false";
startScheduler({ scoringEnabled });
console.log(
  `[scheduler-worker] Ready (PID ${process.pid}, scoring ${scoringEnabled ? "enabled" : "disabled"}, ` +
    `Ollama model ${scoringEnabled ? process.env.OLLAMA_MODEL ?? "not configured" : "not used"}).`,
);
