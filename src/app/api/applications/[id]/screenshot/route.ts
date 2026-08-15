import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isRemoteStorageKey, readStoredObject } from "@/lib/storage";
import { notFoundResponse, withUser } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

/**
 * Application-run screenshots are captured by the local Playwright worker, so
 * on a cloud deployment there is simply nothing to serve — no run was ever
 * driven from there. The read still goes through the storage abstraction so a
 * self-hosted install that writes to object storage is served correctly.
 */
export const GET = withUser<Params>(async (_req, user, { params }) => {
  const { id } = await params;
  // A screenshot is a picture of a filled-in application form — name, address,
  // work history, whatever the page held. Owner-scoped like the run it belongs
  // to, and missing rather than forbidden when it is not yours.
  const run = await prisma.applicationRun.findFirst({ where: { id, userId: user.id } });
  if (!run?.screenshotPath) return notFoundResponse("Screenshot not found.");

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
    return notFoundResponse("Screenshot not found.");
  }
});
