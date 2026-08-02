import { NextResponse } from "next/server";
import { disconnectGmail } from "@/lib/gmail/account";

export async function POST() {
  await disconnectGmail();
  return NextResponse.json({ disconnected: true });
}
