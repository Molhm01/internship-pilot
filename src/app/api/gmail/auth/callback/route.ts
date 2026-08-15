import { NextResponse } from "next/server";
import { exchangeCodeForTokens, fetchUserEmailAddress } from "@/lib/gmail/oauth";
import { saveGmailAccount } from "@/lib/gmail/account";
import { currentUser } from "@/lib/auth/session";

/**
 * Google's redirect back after a mailbox authorization.
 *
 * The session decides whose mailbox this becomes. There is no user id in the
 * callback URL and there must never be one: a parameter naming the account
 * would let anyone who can craft a link attach their own mailbox — or, worse,
 * their tokens — to somebody else's profile.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(new URL(`/documents?gmailError=${encodeURIComponent(error)}`, url.origin));
  }
  if (!code) {
    return NextResponse.redirect(new URL(`/documents?gmailError=missing_code`, url.origin));
  }
  if (!user) {
    return NextResponse.redirect(new URL("/login?next=/documents", url.origin));
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const email = await fetchUserEmailAddress(tokens.access_token);
    await saveGmailAccount(user.id, email, tokens);
    return NextResponse.redirect(new URL(`/documents?gmailConnected=1`, url.origin));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error connecting Gmail.";
    return NextResponse.redirect(new URL(`/documents?gmailError=${encodeURIComponent(message)}`, url.origin));
  }
}
