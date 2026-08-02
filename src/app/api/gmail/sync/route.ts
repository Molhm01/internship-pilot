import { NextResponse } from "next/server";
import { syncGmailInbox } from "@/lib/gmail/sync";

export async function POST() {
  const summary = await syncGmailInbox();
  return NextResponse.json(summary);
}
