import { NextResponse } from "next/server";
import { ApplicationAgentError, retryFailedRun } from "@/lib/applications/queue";
import { executeApplicationRunNow } from "@/lib/applications/autonomousRunner";
import { withUser } from "@/lib/auth/session";
import { extractBearerToken } from "@/lib/gmail/bearer";

type Params = { params: Promise<{ id: string }> };

export const POST = withUser<Params>(async (request, user, { params }) => {
  const { id } = await params;
  try {
    const gmailAccessToken = extractBearerToken(request);
    const retried = await retryFailedRun(id, user.id);
    const outcome = await executeApplicationRunNow(id, user.id, { gmailAccessToken });
    return NextResponse.json({ ...retried, ...outcome });
  } catch (error) {
    if (error instanceof ApplicationAgentError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not retry this ApplicationRun." },
      { status: 500 },
    );
  }
});
