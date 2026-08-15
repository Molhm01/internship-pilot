import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";

/**
 * Extension authentication.
 *
 * ## What was wrong
 *
 * There was one token for the whole installation, kept in `AppSetting`. Every
 * extension presented the same secret, so the server could authenticate the
 * *software* and had no way at all to identify the *person* — which was fine
 * when there was exactly one of them, and is a cross-account read the moment
 * there are two. `/api/extension/profile` answered with "the" profile because
 * only one existed.
 *
 * ## What replaces it
 *
 * A token belongs to one user. It is minted only for someone already signed in
 * on the website, and it names them: `resolveExtensionUser` returns a user id
 * or nothing, and every extension route uses that id as the owner filter.
 *
 * Three properties matter:
 *
 * - **Only the hash is stored.** A copy of the database cannot be replayed as
 *   an extension. The plaintext is displayed once, at creation.
 * - **The extension never asserts identity.** There is no `userId` parameter on
 *   any extension endpoint. If one were added, it would be ignored: the token
 *   is the only thing that says who this is.
 * - **Lookup is by digest, not by scan.** The hash is the unique key, so
 *   verification is one indexed read and there is no list of secrets to compare
 *   against in application code.
 */

export const EXTENSION_AUTH_HEADER = "authorization";

/** Long enough that guessing is not a strategy. */
const TOKEN_BYTES = 32;

export function hashExtensionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssuedExtensionToken {
  id: string;
  /** Shown exactly once. Never stored, never logged, never returned again. */
  token: string;
  tokenHint: string;
  label: string;
  createdAt: Date;
}

/**
 * Mints a token for one user.
 *
 * The caller must have authenticated that user through the session; this
 * function does not check, because it has no request to check against, and a
 * function that took a "trust me" flag would be worse than one that documents
 * its precondition.
 */
export async function issueExtensionToken(
  userId: string,
  label = "Browser extension",
): Promise<IssuedExtensionToken> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const created = await prisma.extensionToken.create({
    data: {
      userId,
      tokenHash: hashExtensionToken(token),
      // Enough to tell two tokens apart in a list; not enough to be useful to
      // anyone who reads it over a shoulder.
      tokenHint: `${token.slice(0, 6)}…`,
      label: label.trim().slice(0, 120) || "Browser extension",
    },
    select: { id: true, tokenHint: true, label: true, createdAt: true },
  });
  return { ...created, token };
}

/** Ends one token. Scoped by user so an id from a request cannot revoke another account's. */
export async function revokeExtensionToken(userId: string, tokenId: string): Promise<boolean> {
  const result = await prisma.extensionToken.updateMany({
    where: { id: tokenId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}

export async function listExtensionTokens(userId: string) {
  return prisma.extensionToken.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    // The hash is deliberately not selected. Nothing outside this module needs
    // it, and a value that never leaves the database cannot leak from a view.
    select: { id: true, tokenHint: true, label: true, lastUsedAt: true, createdAt: true },
  });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get(EXTENSION_AUTH_HEADER) ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/**
 * Constant-time comparison of two digests.
 *
 * The lookup is already by unique hash, so this guards the last step rather
 * than the search: it keeps the "found but not equal" branch from leaking
 * timing, and it costs nothing.
 */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Which user, if any, this extension request is for.
 *
 * Returns a user id or null. Never throws, never falls back to "the first
 * user", and never reads an id out of the request.
 */
export async function resolveExtensionUser(request: Request): Promise<string | null> {
  const token = bearerToken(request);
  if (!token) return null;

  const digest = hashExtensionToken(token);
  const row = await prisma.extensionToken.findUnique({
    where: { tokenHash: digest },
    select: { id: true, userId: true, tokenHash: true, revokedAt: true, expiresAt: true },
  });
  if (!row) return null;
  if (!sameDigest(row.tokenHash, digest)) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  // Best-effort, and deliberately not awaited into the request's critical path:
  // "when did this extension last connect" is useful in Settings and is not
  // worth failing an autofill over.
  void prisma.extensionToken
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return row.userId;
}

/** The label the local application worker's own token carries. */
export const WORKER_TOKEN_LABEL = "Local application worker";

/**
 * A token for the local Playwright worker, acting for one user.
 *
 * The worker drives a real browser with the extension loaded, so it needs a
 * credential like any other extension — and, like any other extension, it must
 * be one user's. Any previous worker token for the same user is revoked first,
 * so restarting the worker replaces its credential instead of accumulating
 * live ones.
 *
 * Only ever called from the local worker process. The plaintext is passed
 * straight into the browser context and never persisted or logged.
 */
export async function issueWorkerExtensionToken(userId: string): Promise<string> {
  await prisma.extensionToken.updateMany({
    where: { userId, label: WORKER_TOKEN_LABEL, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  const { token } = await issueExtensionToken(userId, WORKER_TOKEN_LABEL);
  return token;
}

export function extensionUnauthorizedResponse(): Response {
  return Response.json(
    {
      error:
        "This extension is not connected to an Internship Pilot account. Open Settings → Browser extension on the website, generate a token, and paste it into the extension.",
    },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Wraps an extension route so the body only ever runs with a resolved user.
 *
 * The same shape as `withUser` for website routes, for the same reason: the
 * owner is an argument the handler is given, not something it has to remember
 * to look up.
 */
export function withExtensionUser<Context = unknown>(
  handler: (request: Request, userId: string, context: Context) => Promise<Response>,
): (request: Request, context: Context) => Promise<Response> {
  return async (request: Request, context: Context) => {
    const userId = await resolveExtensionUser(request);
    if (!userId) return extensionUnauthorizedResponse();
    return handler(request, userId, context);
  };
}
