import { NextResponse } from "next/server";
import { ApplicationAgentError, queueAnsweredRun } from "@/lib/applications/queue";
import { executeApplicationRunNow } from "@/lib/applications/autonomousRunner";
import { withUser } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

export const POST = withUser<Params>(async (_request, user, { params }) => {
  const { id } = await params;
  try {
    const queued = await queueAnsweredRun(id, user.id);
    const outcome = await executeApplicationRunNow(id, user.id);
    return NextResponse.json({ ...queued, ...outcome });
  } catch (error) {
    if (error instanceof ApplicationAgentError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not resume this run." }, { status: 500 });
  }
});
