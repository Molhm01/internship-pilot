import { NextResponse } from "next/server";
import {
  issueExtensionToken,
  listExtensionTokens,
  revokeExtensionToken,
} from "@/lib/applications/extensionAuth";
import { withUser } from "@/lib/auth/session";

/**
 * Extension tokens, managed from Settings by the person they belong to.
 *
 * This is a *website* route, not an extension route: it is authenticated by the
 * session cookie, because minting a credential is exactly the operation a
 * credential must not be able to perform for itself.
 *
 * The plaintext token is returned once, by POST, and never again — only its
 * SHA-256 digest is stored. GET lists what exists without the secret.
 */
export const GET = withUser(async (_request, user) =>
  NextResponse.json(
    { tokens: await listExtensionTokens(user.id) },
    { headers: { "cache-control": "no-store" } },
  ),
);

export const POST = withUser(async (request, user) => {
  const body = (await request.json().catch(() => null)) as { label?: unknown } | null;
  const label = typeof body?.label === "string" ? body.label : undefined;
  const issued = await issueExtensionToken(user.id, label);
  return NextResponse.json(
    {
      // Said plainly, because the UI has to say it too.
      notice: "Copy this now. It is shown once and cannot be recovered.",
      token: issued.token,
      id: issued.id,
      tokenHint: issued.tokenHint,
      label: issued.label,
      createdAt: issued.createdAt,
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
});

export const DELETE = withUser(async (request, user) => {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "A token id is required." }, { status: 400 });
  // Scoped by user, so an id belonging to another account revokes nothing and
  // reports the same "not found" as an id that never existed.
  const revoked = await revokeExtensionToken(user.id, id);
  if (!revoked) return NextResponse.json({ error: "That token was not found." }, { status: 404 });
  return NextResponse.json({ revoked: true }, { headers: { "cache-control": "no-store" } });
});
