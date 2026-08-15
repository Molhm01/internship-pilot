import { withUser } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { buildAuthUrl, GmailNotConfiguredError } from "@/lib/gmail/oauth";

/**
 * Starts the Gmail authorization.
 *
 * Behind a session because the callback attaches the mailbox to whoever is
 * signed in — an anonymous start would send someone to Google and then have
 * nowhere to put the result.
 */
export const GET = withUser(async () => {
  try {
    const url = buildAuthUrl();
    return NextResponse.redirect(url);
  } catch (err) {
    if (err instanceof GmailNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
});
