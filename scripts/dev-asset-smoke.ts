import { spawn, execSync, type ChildProcess } from "node:child_process";
import path from "node:path";

import {
  extractDocumentAssets,
  summarizeAssetHealth,
  type AssetProbeResult,
} from "@/lib/runtime/documentAssets";

/**
 * Bounded smoke of the ACTUAL development path.
 *
 * The existing Windows gate runs `next build --webpack`, which proves the app
 * compiles. It does not prove the dev server can serve what it compiled — and
 * the failure that took the local install down was exactly that: a running dev
 * server whose document rendered while every `_next/static` chunk and
 * stylesheet behind it failed. A compile gate cannot see that; only fetching
 * the page and then fetching what the page asks for can.
 *
 * Deliberately minimal. It starts `next dev --webpack` on a temporary port,
 * loads two routes that need no database, verifies their assets, and stops the
 * process. No Ollama, no scheduler, no application worker, no local launcher.
 */

const PORT = Number(process.env.DEV_SMOKE_PORT ?? 3517);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROUTES = ["/", "/login"];
const READY_TIMEOUT_MS = Number(process.env.DEV_SMOKE_READY_TIMEOUT_MS ?? 240_000);
const ROUTE_TIMEOUT_MS = 120_000;

const failures: string[] = [];

function pass(area: string, detail: string) {
  console.log(`PASS [${area}] ${detail}`);
}

function fail(area: string, detail: string) {
  failures.push(`${area}: ${detail}`);
  console.error(`FAIL [${area}] ${detail}`);
}

function stopTree(child: ChildProcess | null) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${child.pid} /t /f`, { stdio: "ignore" });
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/**
 * A dev server compiles each route the first time it is requested, so the
 * first hit legitimately takes a long time and may momentarily 404 while the
 * router warms up. Retrying is correct here; treating a cold miss as a failure
 * would make this gate flaky for the wrong reason.
 */
async function waitForDocument(route: string, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | null = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}${route}`, {
        signal: AbortSignal.timeout(60_000),
        headers: { accept: "text/html" },
      });
      lastStatus = res.status;
      await res.arrayBuffer().catch(() => undefined);
      if (res.status < 400) return res.status;
    } catch {
      lastStatus = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return lastStatus;
}

async function checkRoute(route: string): Promise<void> {
  const documentUrl = `${BASE_URL}${route}`;
  let html = "";
  let documentStatus: number | null = null;

  try {
    const res = await fetch(documentUrl, { signal: AbortSignal.timeout(60_000), headers: { accept: "text/html" } });
    documentStatus = res.status;
    html = await res.text();
  } catch (error) {
    fail(`dev route ${route}`, `document request failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const assets = extractDocumentAssets(html, documentUrl);
  const probes: AssetProbeResult[] = await Promise.all(
    assets.map(async (asset) => {
      try {
        const res = await fetch(asset.url, { signal: AbortSignal.timeout(60_000) });
        await res.arrayBuffer().catch(() => undefined);
        return { ...asset, status: res.status };
      } catch (error) {
        return { ...asset, status: null, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );

  const report = summarizeAssetHealth({
    documentStatus,
    documentBytes: html.length,
    probes,
    requireAssets: true,
  });

  if (report.ok) {
    pass(`dev route ${route}`, `HTTP ${documentStatus}, ${report.checked} same-origin assets served`);
  } else {
    fail(`dev route ${route}`, report.detail);
  }
}

async function main() {
  const nextCli = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  console.log(`[dev-smoke] starting \`next dev --webpack\` on port ${PORT}…`);

  const child = spawn(process.execPath, [nextCli, "dev", "--webpack", "-p", String(PORT)], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });

  const log: string[] = [];
  const record = (chunk: Buffer) => {
    const text = chunk.toString();
    log.push(text);
    process.stdout.write(text);
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);

  let exited = false;
  child.once("exit", (code) => {
    exited = true;
    if (code !== null && code !== 0) console.error(`[dev-smoke] dev server exited with code ${code}`);
  });

  try {
    const status = await waitForDocument("/", READY_TIMEOUT_MS);
    if (exited) {
      fail("dev server", `\`next dev --webpack\` exited before serving a page.\n${log.slice(-20).join("")}`);
    } else if (status === null || status >= 400) {
      fail("dev server", `/ never became available (last status ${status ?? "no response"}).`);
    } else {
      pass("dev server", `\`next dev --webpack\` served / with HTTP ${status}`);
      for (const route of ROUTES) {
        await waitForDocument(route, ROUTE_TIMEOUT_MS);
        await checkRoute(route);
      }
    }
  } finally {
    console.log("[dev-smoke] stopping the dev server…");
    stopTree(child);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  console.log("\n=== Dev asset smoke summary ===");
  console.log(`failures=${failures.length}`);
  for (const failure of failures) console.error(`- ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
