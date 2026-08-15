import { NextResponse } from "next/server";
import { ApplicationAgentError, enqueueApplication } from "@/lib/applications/queue";
import { withUser } from "@/lib/auth/session";

type Params = { params: Promise<{ id: string }> };

/** Starts an application run, for the signed-in user, against a shared job. */
export const POST = withUser<Params>(async (_req, user, { params }) => {
  const { id } = await params;
  try {
    const result = await enqueueApplication(id, user.id);
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
});
