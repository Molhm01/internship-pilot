import { NextResponse } from "next/server";
import { getGmailAccountStatus } from "@/lib/gmail/account";
import { isGmailConfigured } from "@/lib/gmail/oauth";
import { withUser } from "@/lib/auth/session";

/** Whether THIS user has connected a mailbox. */
export const GET = withUser(async (_request, user) => {
  const status = await getGmailAccountStatus(user.id);
  return NextResponse.json({ ...status, configured: isGmailConfigured() });
});
