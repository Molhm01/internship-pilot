import { NextResponse } from "next/server";
import { ApplicationAgentError } from "@/lib/applications/queue";
import { answerAndResumeApplicationRun } from "@/lib/applications/answerAndResume";
import { executeApplicationRunNow } from "@/lib/applications/autonomousRunner";
import { withUser } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

/** Answers the question a run stopped on and resumes execution immediately. */
export const POST = withUser<Params>(async (req, user, { params }) => {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const answer = typeof body?.answer === "string" ? body.answer.trim() : "";
  if (!answer) return NextResponse.json({ error: "answer is required" }, { status: 400 });

  try {
    const queued = await answerAndResumeApplicationRun(id, answer, body?.reuse === true, user.id);
    const outcome = await executeApplicationRunNow(id, user.id);
    return NextResponse.json({ ...queued, ...outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not resume this run.";
    if (error instanceof ApplicationAgentError || /no pending question/i.test(message)) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
