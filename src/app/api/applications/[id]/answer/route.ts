import { NextResponse } from "next/server";
import { ApplicationAgentError } from "@/lib/applications/queue";
import { answerAndResumeApplicationRun } from "@/lib/applications/answerAndResume";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const answer = typeof body?.answer === "string" ? body.answer.trim() : "";
  if (!answer) return NextResponse.json({ error: "answer is required" }, { status: 400 });

  try {
    const result = await answerAndResumeApplicationRun(id, answer, body?.reuse === true);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ApplicationAgentError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not resume this run." }, { status: 500 });
  }
}
