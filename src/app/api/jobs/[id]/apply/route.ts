import { NextResponse } from "next/server";
import { ApplicationAgentError, enqueueApplication } from "@/lib/applications/queue";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await enqueueApplication(id);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ApplicationAgentError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Application run failed." },
      { status: 500 },
    );
  }
}
