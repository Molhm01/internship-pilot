/**
 * Resolves the ONE canonical local database — the named Prisma Dev instance
 * "internship-pilot" that `npm run local` uses — instead of trusting whatever
 * DATABASE_URL a shell happens to have lying around.
 *
 * Why this exists: `npm run local` deletes any inherited DATABASE_URL and asks
 * Prisma Dev for the instance's *actual* current TCP port every time it starts
 * (Prisma Dev may reuse an existing port or pick a new free one). A stale port
 * baked into `.env` from an earlier session silently points at a different,
 * older local database with different data — same symptom as talking to the
 * wrong server, but with no error, just wrong numbers. Any script that reports
 * or repairs discovery quality must resolve the port the same way `npm run
 * local` does, not read a cached value.
 *
 * A second trap this closes: a local Prisma Dev instance serves ONE database
 * regardless of the database name in the connection URL (see
 * scripts/lib/disposableDatabase.ts). So "the canonical instance" is
 * identified by its host:port, not by a database name — a URL with a
 * different db name but the same host:port as the instance below is still the
 * real database.
 */

import { spawnSync } from "node:child_process";
import { normalizeLocalPrismaTcpUrl, isCanonicalInstanceUrl } from "@/lib/runtime/localStartup";

export { isCanonicalInstanceUrl };

export const LOCAL_PRISMA_NAME = "internship-pilot";

function stripAnsi(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

export class CanonicalDatabaseUnresolvedError extends Error {
  constructor(detail: string) {
    super(
      `Could not prove connection to the canonical local database "${LOCAL_PRISMA_NAME}": ${detail}. ` +
        "Refusing to fall back to a possibly-stale DATABASE_URL. Run `npm run local` (or `npm run local:discovery`) " +
        "at least once so Prisma Dev has an instance to report, then retry.",
    );
    this.name = "CanonicalDatabaseUnresolvedError";
  }
}

/**
 * Asks Prisma Dev for the CURRENT TCP URL of the named "internship-pilot"
 * instance (starting it if it is not already running — the same `--detach`
 * reuse behavior `npm run local` relies on) and returns host/port/url.
 * Throws CanonicalDatabaseUnresolvedError instead of ever guessing.
 */
export function resolveCanonicalDatabaseUrl(): { url: string; host: string; port: number } {
  const result = spawnSync("npx", ["prisma", "dev", "--detach", "--name", LOCAL_PRISMA_NAME], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output = stripAnsi(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  const match = output.match(/postgres(?:ql)?:\/\/[^\s]+/i);
  if (!match) {
    throw new CanonicalDatabaseUnresolvedError(
      `\`npx prisma dev --detach --name ${LOCAL_PRISMA_NAME}\` did not report a TCP URL` +
        (result.error ? ` (${result.error.message})` : ""),
    );
  }

  const url = normalizeLocalPrismaTcpUrl(match[0]);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CanonicalDatabaseUnresolvedError("Prisma Dev reported a URL that could not be parsed");
  }
  const port = Number(parsed.port);
  if (!Number.isFinite(port) || port <= 0) {
    throw new CanonicalDatabaseUnresolvedError("Prisma Dev reported a URL with no usable TCP port");
  }
  return { url, host: parsed.hostname, port };
}

/**
 * Points process.env.DATABASE_URL at the canonical instance and returns its
 * identity for a safe, credential-free log line. Call this before ANY
 * diagnostic or repair script does its first query. Throws (aborts) rather
 * than silently using whatever DATABASE_URL was already set — a stale value
 * must never be used for operational reporting or repair.
 */
export function pinCanonicalDatabaseUrl(): { host: string; port: number; url: string } {
  const { url, host, port } = resolveCanonicalDatabaseUrl();
  process.env.DATABASE_URL = url;
  return { host, port, url };
}

/** Prints the safe identity line every operational script must show before doing real work. */
export function announceCanonicalDatabase(activeJobs: number, canonical: { port: number }): void {
  console.log("database mode: local Prisma Dev");
  console.log(`instance: ${LOCAL_PRISMA_NAME}`);
  console.log(`TCP port: ${canonical.port}`);
  console.log(`active jobs: ${activeJobs}`);
}
