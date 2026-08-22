/*
 * Shared catalogue data, but not public data. A signed-out request has no
 * business mutating the global employer review queue, so verify the server
 * session on every request.
 */
import { guardSession } from "@/lib/auth/session";
import { NextResponse } from "next/server";
import { EmployerReviewError, reviewNewEmployer } from "@/lib/employers/review";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guardSession();
  if (denied) return denied;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || (body.action !== "approve" && body.action !== "reject")) {
    return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });
  }

  try {
    const entry = await reviewNewEmployer({
      id,
      action: body.action,
      officialDomain: typeof body.officialDomain === "string" ? body.officialDomain : undefined,
      careersUrl: typeof body.careersUrl === "string" ? body.careersUrl : undefined,
    });
    return NextResponse.json({ entry });
  } catch (error) {
    if (error instanceof EmployerReviewError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
