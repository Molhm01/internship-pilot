import { NextResponse } from "next/server";
import { syncGmailInbox } from "@/lib/gmail/sync";
import { withUser } from "@/lib/auth/session";

/** Reads the caller's own mailbox. Read-only, as it has always been. */
export const POST = withUser(async (_request, user) => {
  const summary = await syncGmailInbox(user.id);
  return NextResponse.json(summary);
});
