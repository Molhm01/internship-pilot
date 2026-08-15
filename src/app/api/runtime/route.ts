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
import { runtimeCapabilities } from "@/lib/runtime/deployment";

/**
 * What this deployment can do, for a browser that has to decide whether to ask
 * the server or the extension.
 *
 * Deliberately contains no secret, no URL, and no configuration value — only
 * the capability flags derived from where this process runs. It is safe to
 * fetch from any page and is the single place the client learns that it is
 * talking to a hosted website rather than a local install.
 */
export async function GET() {
  const denied = await guardSession();
  if (denied) return denied;
  return NextResponse.json(runtimeCapabilities(), {
    headers: { "cache-control": "no-store" },
  });
}
