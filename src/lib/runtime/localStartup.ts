import type { InstanceComparison, LocalInstanceIdentity } from "@/lib/runtime/localInstance";
import { compareLocalInstance, type InstanceExpectation } from "@/lib/runtime/localInstance";
import type { AssetHealthReport } from "@/lib/runtime/documentAssets";

/**
 * Prisma Dev reports a `localhost` TCP URL. On Windows that name may resolve
 * to ::1 even though the embedded Postgres listener is bound only on IPv4;
 * node-postgres then fails with "Connection terminated unexpectedly". Keep
 * Prisma's dynamically selected port and every query parameter, but make the
 * loopback family explicit for child processes launched by `npm run local`.
 */
export function normalizeLocalPrismaTcpUrl(databaseUrl: string, platform = process.platform): string {
  if (platform !== "win32") return databaseUrl;
  const parsed = new URL(databaseUrl);
  if (parsed.hostname !== "localhost") return databaseUrl;
  parsed.hostname = "127.0.0.1";
  return parsed.toString();
}

function normalizedLocalHost(hostname: string): string {
  return hostname === "localhost" ? "127.0.0.1" : hostname;
}

/**
 * Does `candidateUrl` point at the same physical database server as
 * `canonical` (by host:port, never by database name)?
 *
 * This exists because a local Prisma Dev instance serves ONE database
 * regardless of the database name in the connection URL — so a "disposable"
 * fixture database name is not actually isolated if it shares the canonical
 * instance's host:port. See scripts/lib/disposableDatabase.ts.
 */
export function isCanonicalInstanceUrl(candidateUrl: string, canonical: { host: string; port: number }): boolean {
  try {
    const parsed = new URL(candidateUrl);
    return (
      normalizedLocalHost(parsed.hostname) === normalizedLocalHost(canonical.host) &&
      Number(parsed.port) === canonical.port
    );
  } catch {
    return false;
  }
}

/**
 * What `npm run local` should do about whatever is already on port 3000.
 *
 * This is a pure decision so it can be tested without a stack: the failure it
 * exists to prevent (silently reusing a Next process whose build no longer
 * exists) is exactly the kind of thing that only shows up on a real machine,
 * at the worst moment, and never in CI.
 *
 * Two rules constrain every branch:
 *   1. A server is reused only when it *proves* it came from this checkout and
 *      can actually serve its own assets.
 *   2. Nothing is ever stopped unless it proves it belongs to this repository —
 *      by answering with this repo root, or by being recorded in this repo's
 *      lockfile. An unrelated Node app on port 3000 is reported, never killed.
 */

export type LocalLockSnapshot = {
  repoRoot: string;
  supervisorPid: number | null;
  webPid: number | null;
  schedulerPid: number | null;
  workerPid: number | null;
};

export type LocalStartupProbe = {
  port: number;
  portInUse: boolean;
  /** PID listening on the port, when the OS would tell us. */
  portOwnerPid: number | null;
  portOwnerName: string;
  /** `/api/extension/health` answered as Internship Pilot. */
  healthOk: boolean;
  /** `/api/local/instance` payload, or null when it did not answer. */
  runningInstance: LocalInstanceIdentity | null;
  /** Document + referenced-asset probe. Null when not attempted. */
  assetHealth: AssetHealthReport | null;
  /** This checkout's identity. */
  expected: InstanceExpectation & { repoRoot: string };
  /** Lockfile contents, when present. */
  lock: LocalLockSnapshot | null;
  /** Of the lock's PIDs, the ones still alive. */
  liveLockPids: number[];
};

export type LocalStartupDecision =
  | { action: "start"; reason: string }
  | { action: "reuse"; reason: string }
  | { action: "restart_owned"; reason: string; pids: number[]; comparison: InstanceComparison | null }
  | { action: "abort_foreign_port"; reason: string }
  | { action: "abort_double_start"; reason: string };

function ownedPidsFrom(probe: LocalStartupProbe): number[] {
  const pids = new Set<number>();
  const lockOwnsThisRepo = probe.lock?.repoRoot === probe.expected.repoRoot;

  if (lockOwnsThisRepo && probe.lock) {
    for (const pid of [probe.lock.workerPid, probe.lock.schedulerPid, probe.lock.webPid, probe.lock.supervisorPid]) {
      if (pid && probe.liveLockPids.includes(pid)) pids.add(pid);
    }
  }

  // The port holder is only added once ownership has been established by the
  // caller. `decideLocalStartup` never calls this for a foreign process.
  if (probe.portOwnerPid) pids.add(probe.portOwnerPid);

  return [...pids];
}

export function decideLocalStartup(probe: LocalStartupProbe): LocalStartupDecision {
  if (!probe.portInUse) {
    // A lock whose processes are still alive while the port is free means a
    // sibling supervisor is mid-startup. Double-starting would race two Next
    // servers onto one port and one database.
    if (probe.lock && probe.lock.repoRoot === probe.expected.repoRoot && probe.liveLockPids.length > 0) {
      return {
        action: "abort_double_start",
        reason: `Another Internship Pilot supervisor from this repository is still running (PIDs ${probe.liveLockPids.join(", ")}) but the port is not yet open. Refusing to double-start — run \`npm run local:stop\` if that instance is wedged.`,
      };
    }
    return { action: "start", reason: "Port is free and no live instance is recorded for this repository." };
  }

  const comparison = compareLocalInstance(probe.runningInstance, probe.expected);

  // --- Ownership ---------------------------------------------------------
  // Two independent proofs, either of which is sufficient.
  const provenByIdentity = comparison.sameRepo;
  const provenByLock =
    probe.lock?.repoRoot === probe.expected.repoRoot &&
    probe.portOwnerPid !== null &&
    [probe.lock.webPid, probe.lock.supervisorPid].includes(probe.portOwnerPid);
  const owned = provenByIdentity || provenByLock;

  if (!owned) {
    return {
      action: "abort_foreign_port",
      reason:
        `Port ${probe.port} is held by ${probe.portOwnerName}${probe.portOwnerPid ? ` (PID ${probe.portOwnerPid})` : ""}, which did not identify itself as this Internship Pilot checkout. ` +
        `Internship Pilot will not stop a process it does not own. Stop it yourself, then run \`npm run local\` again.`,
    };
  }

  // --- Compatibility -----------------------------------------------------
  if (!comparison.compatible) {
    return {
      action: "restart_owned",
      reason: comparison.detail,
      pids: ownedPidsFrom(probe),
      comparison,
    };
  }

  if (!probe.healthOk) {
    return {
      action: "restart_owned",
      reason: "The server from this checkout is listening but its health endpoint did not answer as Internship Pilot.",
      pids: ownedPidsFrom(probe),
      comparison,
    };
  }

  if (!probe.assetHealth) {
    return {
      action: "restart_owned",
      reason: "Asset integrity could not be checked on the running server, so it is not safe to reuse.",
      pids: ownedPidsFrom(probe),
      comparison,
    };
  }

  if (!probe.assetHealth.ok) {
    return {
      action: "restart_owned",
      reason: `The running server answers health checks but cannot serve its own build output: ${probe.assetHealth.detail}`,
      pids: ownedPidsFrom(probe),
      comparison,
    };
  }

  return {
    action: "reuse",
    reason: `A healthy Internship Pilot instance from this checkout is already running (${probe.assetHealth.checked} assets verified).`,
  };
}

/**
 * Which recorded PIDs `npm run local:stop` is allowed to stop.
 *
 * Membership in this repository's lockfile is the only qualification, and the
 * lockfile must name this repo root. A PID that is merely listening on the
 * port is not included — that is handled separately, and only after the
 * process has identified itself as belonging here.
 */
export function stoppablePids(input: {
  repoRoot: string;
  lock: LocalLockSnapshot | null;
  isAlive: (pid: number) => boolean;
  selfPid: number;
}): { pid: number; label: string }[] {
  const { repoRoot, lock, isAlive, selfPid } = input;
  if (!lock || lock.repoRoot !== repoRoot) return [];

  const candidates: { pid: number | null; label: string }[] = [
    { pid: lock.workerPid, label: "Application worker" },
    { pid: lock.schedulerPid, label: "Scheduler + scoring worker" },
    { pid: lock.webPid, label: "Web server" },
    { pid: lock.supervisorPid, label: "Supervisor" },
  ];

  const seen = new Set<number>();
  const result: { pid: number; label: string }[] = [];
  for (const candidate of candidates) {
    const pid = candidate.pid;
    if (!pid || pid === selfPid || seen.has(pid)) continue;
    if (!isAlive(pid)) continue;
    seen.add(pid);
    result.push({ pid, label: candidate.label });
  }
  return result;
}

/**
 * The recovery path for "the lock is gone or stale, but something owned by
 * this repository is still holding the port". Returns the PID to stop only
 * when the listening process proved it is this checkout.
 */
export function orphanRecoveryTarget(input: {
  portOwnerPid: number | null;
  runningInstance: LocalInstanceIdentity | null;
  expectedRepoRootHash: string;
}): { pid: number; detail: string } | null {
  const { portOwnerPid, runningInstance, expectedRepoRootHash } = input;
  if (!portOwnerPid || !runningInstance) return null;
  if (runningInstance.repoRootHash !== expectedRepoRootHash) return null;
  return {
    pid: portOwnerPid,
    detail: `An orphaned Internship Pilot web process from this repository (started ${runningInstance.startedAt}) is still holding the port.`,
  };
}
