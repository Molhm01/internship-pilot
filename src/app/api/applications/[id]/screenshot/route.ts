import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isRemoteStorageKey, readStoredObject } from "@/lib/storage";

/**
 * Application-run screenshots are captured by the local Playwright worker, so
 * on a cloud deployment there is simply nothing to serve — no run was ever
 * driven from there. The read still goes through the storage abstraction so a
 * self-hosted install that writes to object storage is served correctly.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await prisma.applicationRun.findUnique({ where: { id } });
  if (!run?.screenshotPath) return NextResponse.json({ error: "Screenshot not found." }, { status: 404 });

  // Local keys stay confined to the run output directory. A row is not a
  // trusted path source just because this application wrote it.
  const key = run.screenshotPath;
  if (!isRemoteStorageKey(key) && !key.replace(/\\/g, "/").startsWith("data/generated/")) {
    return NextResponse.json({ error: "Invalid screenshot path." }, { status: 400 });
  }

  try {
    return new NextResponse(await readStoredObject(key), {
      headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Screenshot not found." }, { status: 404 });
  }
}
