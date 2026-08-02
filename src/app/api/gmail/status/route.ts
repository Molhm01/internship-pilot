import { NextResponse } from "next/server";
import { getGmailAccountStatus } from "@/lib/gmail/account";
import { isGmailConfigured } from "@/lib/gmail/oauth";

export async function GET() {
  const status = await getGmailAccountStatus();
  return NextResponse.json({ ...status, configured: isGmailConfigured() });
}
