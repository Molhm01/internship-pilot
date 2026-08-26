/*
 * Shared data, but not public data.
 *
 * Every handler in this file operates on the global catalogue rather than on
 * one person's rows, so there is no owner to filter by — but a signed-out
 * request still has no business here, and the proxy's cookie check is not an
 * authorization layer. The session is verified on the server, per request.
 */
import { guardSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { getCachedSchedulerHealth } from "@/lib/sync/schedulerState";

export async function GET(request: Request) {
  const denied = await guardSession();
  if (denied) return denied;
  const force = new URL(request.url).searchParams.get("fresh") === "1";
  const { health, computedAt } = await getCachedSchedulerHealth({ force });
  return NextResponse.json({ ...health, computedAt });
}
