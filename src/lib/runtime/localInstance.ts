import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { EXTENSION_PROTOCOL_VERSION, SERVER_BUILD } from "@/lib/applications/extensionProtocol";

/**
 * Local instance identity.
 *
 * A Windows run of `npm run local` reused a Next process that was still
 * listening on port 3000 after `.next` had been deleted and rebuilt. The
 * process answered `/api/extension/health` with HTTP 200, so the launcher
 * declared it healthy — but every JS chunk and stylesheet the document
 * referenced belonged to a build that no longer existed on disk. The browser
 * got HTML with no CSS and no hydration: default-blue links, an unbounded
 * logo, an unusable page.
 *
 * Version constants alone cannot detect that, because they are compiled into
 * the source and are identical across builds. What distinguishes the stale
 * process from a correct one is *which working tree and which build* it came
 * from, so that is what a local instance now states about itself.
 *
 * This is deliberately NOT added to `/api/extension/health`: that endpoint is
 * public on the hosted deployment, and a repository path plus a commit SHA is
 * not something a public handshake should hand out. It lives behind
 * `/api/local/instance`, which only answers in a local runtime.
 */

export const LOCAL_INSTANCE_PROTOCOL = 1;

export type LocalInstanceIdentity = {
  /** Shape version of this payload itself. */
  instanceProtocol: number;
  service: "Internship Pilot";
  /** Absolute repo root of the process that answered. */
  repoRoot: string;
  /** Stable hash of the repo root, comparable without printing the path. */
  repoRootHash: string;
  /** Git commit the working tree was on when this process started, if readable. */
  commit: string | null;
  commitSource: "git" | "env" | "unknown";
  /** Next.js build id, when a built `.next` exists (production/`next start`). */
  buildId: string | null;
  /** Random per-process id — two runs of the same commit are still distinct. */
  sessionId: string;
  /** ISO timestamp of when this Node process started. */
  startedAt: string;
  nodeVersion: string;
  pid: number;
  serverBuild: string;
  protocolVersion: number;
};

/** Normalizes a filesystem path so two spellings of one directory agree. */
export function normalizeRepoRoot(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

export function hashRepoRoot(value: string): string {
  return createHash("sha256").update(normalizeRepoRoot(value)).digest("hex").slice(0, 16);
}

export function parsePackedRefs(contents: string, ref: string): string | null {
  for (const line of contents.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const [sha, name] = line.split(/\s+/);
    if (name === ref && /^[0-9a-f]{7,40}$/i.test(sha ?? "")) return sha as string;
  }
  return null;
}

function readCommitFromGitDir(gitDir: string): { commit: string | null; source: "git" | "unknown" } {
  const headPath = path.join(gitDir, "HEAD");
  if (!existsSync(headPath)) return { commit: null, source: "unknown" };
  const head = readFileSync(headPath, "utf8").trim();

  if (!head.startsWith("ref:")) {
    return /^[0-9a-f]{7,40}$/i.test(head) ? { commit: head, source: "git" } : { commit: null, source: "unknown" };
  }

  const ref = head.slice(4).trim();
  const looseRef = path.join(gitDir, ...ref.split("/"));
  if (existsSync(looseRef)) {
    const sha = readFileSync(looseRef, "utf8").trim();
    if (/^[0-9a-f]{7,40}$/i.test(sha)) return { commit: sha, source: "git" };
  }

  const packedPath = path.join(gitDir, "packed-refs");
  if (existsSync(packedPath)) {
    const sha = parsePackedRefs(readFileSync(packedPath, "utf8"), ref);
    if (sha) return { commit: sha, source: "git" };
  }
  return { commit: null, source: "unknown" };
}

/**
 * Reads HEAD without spawning git: the launcher runs this on every start, and
 * a process spawn on Windows is both slower and more failure-prone than
 * reading two small files. Falls back through packed-refs, which is how a
 * freshly cloned repository stores branch tips.
 */
export function readGitCommit(repoRoot: string): { commit: string | null; source: "git" | "env" | "unknown" } {
  const fromEnv =
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    process.env.INTERNSHIP_PILOT_COMMIT?.trim();
  if (fromEnv) return { commit: fromEnv, source: "env" };

  const gitPath = path.join(repoRoot, ".git");
  if (!existsSync(gitPath)) return { commit: null, source: "unknown" };

  try {
    // A worktree or submodule checkout stores `gitdir: <path>` in a .git FILE;
    // the ordinary case is a directory, where this read throws EISDIR.
    const gitStat = readFileSync(gitPath, "utf8").trim();
    if (gitStat.startsWith("gitdir:")) {
      const pointer = gitStat.slice("gitdir:".length).trim();
      return readCommitFromGitDir(path.isAbsolute(pointer) ? pointer : path.join(repoRoot, pointer));
    }
  } catch {
    // Fall through to the directory case below.
  }

  try {
    return readCommitFromGitDir(gitPath);
  } catch {
    return { commit: null, source: "unknown" };
  }
}

function readBuildId(repoRoot: string): string | null {
  try {
    const file = path.join(repoRoot, ".next", "BUILD_ID");
    return existsSync(file) ? readFileSync(file, "utf8").trim() || null : null;
  } catch {
    return null;
  }
}

const SESSION_ID = randomUUID();
const STARTED_AT = new Date().toISOString();

export function localInstanceIdentity(repoRoot = process.cwd()): LocalInstanceIdentity {
  const { commit, source } = readGitCommit(repoRoot);
  return {
    instanceProtocol: LOCAL_INSTANCE_PROTOCOL,
    service: "Internship Pilot",
    repoRoot,
    repoRootHash: hashRepoRoot(repoRoot),
    commit,
    commitSource: source,
    buildId: readBuildId(repoRoot),
    sessionId: SESSION_ID,
    startedAt: STARTED_AT,
    nodeVersion: process.version,
    pid: process.pid,
    serverBuild: SERVER_BUILD,
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Comparison — pure, so the launcher's reuse decision is unit-testable.
// ---------------------------------------------------------------------------

export type InstanceComparison = {
  /** True only when the running process provably came from this checkout. */
  sameRepo: boolean;
  /** True when the running process is safe to reuse as-is. */
  compatible: boolean;
  reason:
    | "match"
    | "no_running_identity"
    | "different_repo"
    | "different_commit"
    | "different_build"
    | "different_protocol";
  detail: string;
};

export type InstanceExpectation = Pick<
  LocalInstanceIdentity,
  "repoRootHash" | "commit" | "buildId" | "instanceProtocol"
>;

export function compareLocalInstance(
  running: LocalInstanceIdentity | null,
  expected: InstanceExpectation,
): InstanceComparison {
  if (!running) {
    return {
      sameRepo: false,
      compatible: false,
      reason: "no_running_identity",
      detail:
        "The server on this port did not answer /api/local/instance, so it cannot prove which checkout it was built from.",
    };
  }

  if (running.repoRootHash !== expected.repoRootHash) {
    return {
      sameRepo: false,
      compatible: false,
      reason: "different_repo",
      detail: `The server on this port belongs to a different Internship Pilot checkout (${running.repoRoot}).`,
    };
  }

  if (running.instanceProtocol !== expected.instanceProtocol) {
    return {
      sameRepo: true,
      compatible: false,
      reason: "different_protocol",
      detail: `The running server speaks local-instance protocol ${running.instanceProtocol}; this checkout speaks ${expected.instanceProtocol}.`,
    };
  }

  // A commit is only decisive when BOTH sides could read one. An installation
  // without a .git directory is a legitimate deployment, not a mismatch.
  if (expected.commit && running.commit && running.commit !== expected.commit) {
    return {
      sameRepo: true,
      compatible: false,
      reason: "different_commit",
      detail: `The running server started on commit ${running.commit.slice(0, 12)}; this checkout is on ${expected.commit.slice(0, 12)}.`,
    };
  }

  // Only compare build ids when the running server reported one. A dev server
  // has no BUILD_ID, and a stale one on disk must not be read as a mismatch.
  if (running.buildId && expected.buildId && running.buildId !== expected.buildId) {
    return {
      sameRepo: true,
      compatible: false,
      reason: "different_build",
      detail: `The running server is serving build ${running.buildId}; the built output on disk is ${expected.buildId}.`,
    };
  }

  return { sameRepo: true, compatible: true, reason: "match", detail: "Running server matches this checkout." };
}
