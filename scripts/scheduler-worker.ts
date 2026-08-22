import "dotenv/config";
import { prisma } from "@/lib/db";
import { startScheduler } from "@/lib/sync/scheduler";

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

startScheduler();
console.log(
  `[scheduler-worker] Ready (PID ${process.pid}, Ollama model ${process.env.OLLAMA_MODEL ?? "not configured"}).`,
);
