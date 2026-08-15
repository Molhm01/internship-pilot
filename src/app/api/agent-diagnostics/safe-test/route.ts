import path from "node:path";
import { execFile } from "node:child_process";
import { NextResponse } from "next/server";
import { isCloudRuntime, LOCAL_ONLY_FEATURES } from "@/lib/runtime/deployment";

/**
 * Runs the application-agent regression script in a child process. That means
 * a checked-out repository, a node_modules tree, and a Chromium install — a
 * development machine, in other words. A hosted deployment has none of them,
 * so the request is declined by name instead of failing on a missing binary.
 */
export async function POST() {
  if (isCloudRuntime()) {
    return NextResponse.json(
      { pass: false, output: "", error: LOCAL_ONLY_FEATURES.childProcess },
      { status: 501 },
    );
  }
  return new Promise<Response>((resolve) => {
    try {
      const cli = path.join(/* turbopackIgnore: true */ process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
      execFile(process.execPath, [cli, "scripts/test-application-agent.ts"], {
        cwd: process.cwd(),
        env: { ...process.env, FORCE_HEADLESS: "1" },
        timeout: 240_000,
      }, (error, stdout, stderr) => {
        resolve(NextResponse.json({ pass: !error, output: `${stdout}\n${stderr}`.trim(), error: error?.message ?? null }, { status: error ? 500 : 200 }));
      });
    } catch (error) {
      resolve(NextResponse.json({ pass: false, output: "", error: error instanceof Error ? error.stack ?? error.message : String(error) }, { status: 500 }));
    }
  });
}
