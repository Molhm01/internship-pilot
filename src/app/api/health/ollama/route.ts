import { NextResponse } from "next/server";
import { checkOllamaHealth, OLLAMA_MODEL } from "@/lib/ollama";

export async function GET() {
  const health = await checkOllamaHealth();
  return NextResponse.json({ ...health, model: OLLAMA_MODEL });
}
