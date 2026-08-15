/*
 * Shared data, but not public data.
 *
 * Every handler in this file operates on the global catalogue rather than on
 * one person's rows, so there is no owner to filter by — but a signed-out
 * request still has no business here, and the proxy's cookie check is not an
 * authorization layer. The session is verified on the server, per request.
 */
import { guardSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const denied = await guardSession();
  if (denied) return denied;
  const entries = await prisma.newEmployerReview.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ entries });
}
