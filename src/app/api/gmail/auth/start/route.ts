import { NextResponse } from "next/server";
import { buildAuthUrl, GmailNotConfiguredError } from "@/lib/gmail/oauth";

export async function GET() {
  try {
    const url = buildAuthUrl();
    return NextResponse.redirect(url);
  } catch (err) {
    if (err instanceof GmailNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
