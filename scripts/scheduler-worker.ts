import "dotenv/config";
import { startScheduler } from "@/lib/sync/scheduler";

/**
 * Standalone long-lived scheduler process.
 *
 * Keeping discovery, verification, Gmail tracking, description hydration and
 * ATS scoring outside the Next.js process prevents server-only PostgreSQL and
 * Node dependencies from entering Next's Webpack/Turbopack graph. The durable
 * queue/state remains in PostgreSQL, so restarting this worker does not lose
 * work.
 */
startScheduler();
console.log(`[scheduler-worker] Ready (PID ${process.pid}).`);

function stop(signal: NodeJS.Signals): void {
  console.log(`[scheduler-worker] ${signal} received; stopping.`);
  process.exit(0);
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
