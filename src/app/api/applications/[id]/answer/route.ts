import { NextResponse } from "next/server";
import { ApplicationAgentError } from "@/lib/applications/queue";
import { answerAndResumeApplicationRun } from "@/lib/applications/answerAndResume";
import { withUser } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

/** Answers the question a run stopped on. Only on the caller's own run. */
export const POST = withUser<Params>(async (req, user, { params }) => {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const answer = typeof body?.answer === "string" ? body.answer.trim() : "";
  if (!answer) return NextResponse.json({ error: "answer is required" }, { status: 400 });

  try {
    const result = await answerAndResumeApplicationRun(id, answer, body?.reuse === true, user.id);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ApplicationAgentError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not resume this run." }, { status: 500 });
  }
});
