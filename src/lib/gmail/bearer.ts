import type { NextRequest } from "next/server";

/**
 * Extracts a client-supplied Google OAuth access token from the
 * `Authorization: Bearer <token>` header.
 */
export function extractBearerToken(req: Request | NextRequest): string | null {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token && token.length >= 20 ? token : null;
}
