import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

async function isReadableExecutable(candidate: string | null | undefined): Promise<string | null> {
  if (!candidate) return null;
  try {
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      return null;
    }
  }
}

/**
 * Resolves a usable Chromium or chrome-headless-shell executable on either a
 * local developer machine or a containerized cloud runtime (e.g. Cloud Run
 * with pre-installed `/ms-playwright`). Returns `null` cleanly on minimal
 * serverless environments where no Chromium binary is present.
 */
export async function resolveChromiumExecutablePath(): Promise<string | null> {
  const explicit = await isReadableExecutable(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim());
  if (explicit) return explicit;

  try {
    const { chromium } = await import("playwright");
    const defaultPath = await isReadableExecutable(chromium.executablePath());
    if (defaultPath) return defaultPath;
  } catch {
    // Playwright package unavailable or executable path lookup failed
  }

  const staticCandidates = [
    "/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  for (const candidate of staticCandidates) {
    const found = await isReadableExecutable(candidate);
    if (found) return found;
  }

  const browserRoots = Array.from(
    new Set(
      [process.env.PLAYWRIGHT_BROWSERS_PATH, "/ms-playwright"].filter(
        (v): v is string => Boolean(v && v.trim()),
      ),
    ),
  );

  for (const root of browserRoots) {
    const entries = await readdir(root).catch(() => [] as string[]);
    for (const entry of entries.sort()) {
      if (entry.startsWith("chromium_headless_shell")) {
        const found = await isReadableExecutable(
          path.join(/* turbopackIgnore: true */ root, entry, "chrome-headless-shell-linux64", "chrome-headless-shell"),
        );
        if (found) return found;
      }
      if (entry.startsWith("chromium-")) {
        const found = await isReadableExecutable(
          path.join(/* turbopackIgnore: true */ root, entry, "chrome-linux64", "chrome"),
        );
        if (found) return found;
      }
    }
  }

  return null;
}

export function headlessChromiumLaunchArgs(): string[] {
  return [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ];
}
