import { NextResponse } from "next/server";
import { ApplicationAgentError } from "@/lib/applications/queue";
import { DocumentGenerationError } from "@/lib/documents/generate";
import {
  getAutopilotConfig,
  prepareAndApplyForJob,
  type AutopilotMode,
} from "@/lib/applications/autonomousRunner";
import { withUser } from "@/lib/auth/session";
import { extractBearerToken } from "@/lib/gmail/bearer";

type Params = { params: Promise<{ id: string }> };

/** Prepares match/documents if needed and executes an autonomous application run immediately. */
export const POST = withUser<Params>(async (req, user, { params }) => {
  const { id } = await params;
  try {
    const body = await req.json().catch(() => null);
    const gmailAccessToken = extractBearerToken(req);
    const config = await getAutopilotConfig(user.id);
    const mode: AutopilotMode =
      body?.mode === "fill_to_submit"
        ? "fill_to_submit"
        : body?.mode === "auto_submit"
          ? "auto_submit"
          : config.mode;

    const outcome = await prepareAndApplyForJob(id, user.id, { mode, gmailAccessToken });
    return NextResponse.json({
      ...outcome,
      queued: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Application run failed.";
    if (
      err instanceof ApplicationAgentError
      || err instanceof DocumentGenerationError
      || /not found|quarantined|security-blocked|closed|not currently active|eligibility mismatch|usable official application URL|usable job description|job description/i.test(message)
    ) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
