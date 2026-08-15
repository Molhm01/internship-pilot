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
import { checkCompany } from "@/lib/sync/companyDiscovery";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guardSession();
  if (denied) return denied;
  const { id } = await params;
  try {
    const result = await checkCompany(id);
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Check failed" },
      { status: 400 },
    );
  }
}
