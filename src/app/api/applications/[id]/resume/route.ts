import { NextResponse } from "next/server";
import { ApplicationAgentError, queueAnsweredRun } from "@/lib/applications/queue";
import { withUser } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

export const POST = withUser<Params>(async (_request, user, { params }) => {
  const { id } = await params;
  try {
    return NextResponse.json(await queueAnsweredRun(id, user.id));
  } catch (error) {
    if (error instanceof ApplicationAgentError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not resume this run." }, { status: 500 });
  }
});
