import { NextResponse } from "next/server";
import { ApplicationAgentError, queueAnsweredRun } from "@/lib/applications/queue";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(await queueAnsweredRun(id));
  } catch (error) {
    if (error instanceof ApplicationAgentError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not resume this run." }, { status: 500 });
  }
}
