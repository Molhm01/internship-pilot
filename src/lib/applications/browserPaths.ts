import path from "node:path";

/**
 * Filesystem locations the local application worker uses.
 *
 * Split out of browserProfile.ts, which imports Playwright at module scope.
 * Diagnostics needs only these two paths, and pulling a ~300 MB browser
 * automation dependency into a route bundle to compute a string is not a cost
 * worth paying — least of all on a deployment where no browser is driven.
 */
export function applicationProfilePath(): string {
  const configured = process.env.APPLICATION_BROWSER_PROFILE_DIR ?? "data/browser-profile";
  return path.resolve(process.cwd(), configured);
}

/** Absolute path of the unpacked Manifest V3 extension the worker loads. */
export function applicationExtensionPath(): string {
  const configured = process.env.INTERNSHIP_PILOT_EXTENSION_DIR ?? path.join("extension", "dist");
  return path.resolve(process.cwd(), configured);
}
