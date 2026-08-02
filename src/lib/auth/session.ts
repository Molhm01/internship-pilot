import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";

/**
 * Session handling.
 *
 * The cookie holds a random 256-bit value; the database holds only its SHA-256
 * digest. A copy of the database therefore cannot be replayed as a login, and
 * the raw token never appears in a log, a query string, or an API response.
 */

export const SESSION_COOKIE = "internship_pilot_session";
/** Thirty days. Long enough to be usable, short enough to expire. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type SessionUser = {
  id: string;
  email: string;
  displayName: string | null;
};

/** Issues a session and returns the raw cookie value exactly once. */
export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await prisma.userSession.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  return token;
}

/** Applies the session cookie. `httpOnly` keeps page scripts away from it. */
export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // The app runs on http://localhost, where a Secure cookie would be dropped.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/**
 * The signed-in user, or null.
 *
 * An expired session is deleted on sight rather than merely rejected, so a
 * stale row cannot linger and be resurrected by a clock change.
 */
export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.userSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.userSession.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  return {
    id: session.user.id,
    email: session.user.email,
    displayName: session.user.displayName,
  };
}

/** Ends the current session everywhere, not just in this browser. */
export async function destroyCurrentSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.userSession.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  await clearSessionCookie();
}

/** Removes every expired row. Cheap, and keeps the table from growing forever. */
export async function pruneExpiredSessions(): Promise<void> {
  await prisma.userSession.deleteMany({ where: { expiresAt: { lte: new Date() } } });
}
