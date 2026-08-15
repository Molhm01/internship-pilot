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
  const health = await checkOllamaHealth();
  return NextResponse.json({
    ...health,
    model: OLLAMA_MODEL,
    localAiOffline: isLocalAiUnreachable(),
    runtime: runtimeLocation(),
  });
}
