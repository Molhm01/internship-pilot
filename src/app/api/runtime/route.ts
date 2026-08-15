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
  return NextResponse.json(runtimeCapabilities(), {
    headers: { "cache-control": "no-store" },
  });
}
