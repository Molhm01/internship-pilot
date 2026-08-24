import { NextResponse } from "next/server";
import { withUser } from "@/lib/auth/session";
import { ensureApplicationDocuments } from "@/lib/documents/applicationReadiness";

type Params = { params: Promise<{ id: string }> };

export const POST = withUser<Params>(async (request, user, { params }) => {
  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({}));
    const result = await ensureApplicationDocuments(id, user.id, {
      includeCoverLetter: body?.includeCoverLetter !== false,
    });
    return NextResponse.json({
      ok: true,
      fingerprint: result.fingerprint,
      reused: result.reused,
      documents: result.documents,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Application documents could not be prepared.";
    return NextResponse.json({ error: message.slice(0, 400) }, { status: 400 });
  }
});
