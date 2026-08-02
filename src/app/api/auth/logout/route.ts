import { NextResponse } from "next/server";
import { destroyCurrentSession } from "@/lib/auth/session";

/** Deletes the session row as well as the cookie, so the token cannot be reused. */
export async function POST() {
  await destroyCurrentSession();
  return NextResponse.json({ ok: true });
}
