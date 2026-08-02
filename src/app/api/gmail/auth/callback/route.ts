import { NextResponse } from "next/server";
import { exchangeCodeForTokens, fetchUserEmailAddress } from "@/lib/gmail/oauth";
import { saveGmailAccount } from "@/lib/gmail/account";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(new URL(`/documents?gmailError=${encodeURIComponent(error)}`, url.origin));
  }
  if (!code) {
    return NextResponse.redirect(new URL(`/documents?gmailError=missing_code`, url.origin));
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const email = await fetchUserEmailAddress(tokens.access_token);
    await saveGmailAccount(email, tokens);
    return NextResponse.redirect(new URL(`/documents?gmailConnected=1`, url.origin));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error connecting Gmail.";
    return NextResponse.redirect(new URL(`/documents?gmailError=${encodeURIComponent(message)}`, url.origin));
  }
}
