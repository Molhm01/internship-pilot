import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";

export async function GET() {
  const user = await currentUser();
  return NextResponse.json({ user }, { headers: { "cache-control": "no-store" } });
}
