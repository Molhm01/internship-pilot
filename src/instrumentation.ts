import { isCloudRuntime } from "@/lib/runtime/deployment";

/**
 * The persistent scheduler, started once when the server boots.
 *
 * It owns long-lived `setInterval` timers that sync job sources and drive the
 * local AI match worker — a shape that only makes sense in a process that
 * stays alive. A serverless function does not: it is frozen between requests,
 * so the timers fire unpredictably, and every cold start would register a new
 * set of them. Combined with model calls that a hosted server cannot make
 * anyway, that is churn against the database in exchange for nothing.
 *
 * So the scheduler runs on local installs only. Recurring work on a deployment
 * belongs to a platform scheduler invoking a route, not to a timer inside a
 * request handler.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (isCloudRuntime()) {
    console.info(
      "[scheduler] Not started: this is a hosted runtime, and the sync/AI-match scheduler is a long-lived local process.",
    );
    return;
  }
  const { startScheduler } = await import("@/lib/sync/scheduler");
  startScheduler();
}
