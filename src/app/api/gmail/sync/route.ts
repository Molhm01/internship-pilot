import { NextResponse } from "next/server";
import { syncGmailInbox } from "@/lib/gmail/sync";
import { extractBearerToken } from "@/lib/gmail/bearer";
import { withUser } from "@/lib/auth/session";

/** Reads the caller's own mailbox. Read-only, as it has always been. */
export const POST = withUser(async (request, user) => {
  const bearerToken = extractBearerToken(request);
  const summary = await syncGmailInbox(user.id, bearerToken);
  return NextResponse.json(summary);
});
