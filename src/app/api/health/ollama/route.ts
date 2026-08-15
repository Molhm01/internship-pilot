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
import { checkOllamaHealth, isLocalAiUnreachable, OLLAMA_MODEL } from "@/lib/ollama";
import { runtimeLocation } from "@/lib/runtime/deployment";

/**
 * Ollama health, answered truthfully from wherever this server is running.
 *
 * On a deployed website there is no probe to make: the user's Ollama is on the
 * user's computer and this server has no route to it. `localAiOffline` says so
 * explicitly, so the browser can offer "Connect Local Agent" instead of
 * reporting a model outage that is not happening.
 */
export async function GET() {
  const denied = await guardSession();
  if (denied) return denied;
  const health = await checkOllamaHealth();
  return NextResponse.json({
    ...health,
    model: OLLAMA_MODEL,
    localAiOffline: isLocalAiUnreachable(),
    runtime: runtimeLocation(),
  });
}
