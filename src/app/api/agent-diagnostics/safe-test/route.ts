import path from "node:path";
import { execFile } from "node:child_process";
import { NextResponse } from "next/server";

export async function POST() {
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
