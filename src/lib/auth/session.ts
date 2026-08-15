import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/betterAuth";

/**
 * Who is asking.
 *
 * This module is the single place the application answers that question, and
 * every private route goes through it. That is deliberate: the rule this whole
 * conversion exists to enforce — *the session decides the owner, never the
 * request* — is only enforceable if there is one function that can be audited
 * and one that everything calls.
 *
 * There is no function here that takes a user id. A `userId` in a query string,
 * a JSON body, or a header is a claim by whoever sent it, and this application
 * does not accept claims. It reads the signed session cookie and nothing else.
 */

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  image: string | null;
  emailVerified: boolean;
};

/** The signed-in user, or null. Never throws — callers decide what null means. */
export async function currentUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name ?? "",
    image: session.user.image ?? null,
    emailVerified: Boolean(session.user.emailVerified),
  };
}

/** Thrown by `requireUser`; carries the response the route should return. */
export class UnauthenticatedError extends Error {
  readonly response: NextResponse;

  constructor() {
    super("Authentication required.");
    this.name = "UnauthenticatedError";
    this.response = unauthorizedResponse();
  }
}

export function unauthorizedResponse(): NextResponse {
  return NextResponse.json(
    { error: "You need to be signed in to do that." },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

/**
 * A signed-in user, or a thrown 401.
 *
 * The throwing form exists so a route cannot *forget* to handle the null case:
 * `const user = await requireUser()` either yields a real user or never returns,
 * where `if (!user) return 401` is a line somebody can leave out and no type
 * checker will notice.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new UnauthenticatedError();
  return user;
}

/**
 * Wraps a route handler so `requireUser()` inside it becomes a 401 rather than
 * a 500.
 *
 * ```ts
 * export const GET = withUser(async (_request, user) => {
 *   const rows = await prisma.resumeFact.findMany({ where: { userId: user.id } });
 *   return NextResponse.json({ facts: rows });
 * });
 * ```
 *
 * The `user` argument is the only source of ownership the body is given, which
 * is the point: there is nothing else in scope to accidentally filter by.
 */
export function withUser<Context = unknown>(
  handler: (request: Request, user: SessionUser, context: Context) => Promise<Response>,
): (request: Request, context: Context) => Promise<Response> {
  return async (request: Request, context: Context) => {
    let user: SessionUser;
    try {
      user = await requireUser();
    } catch (error) {
      if (error instanceof UnauthenticatedError) return error.response;
      throw error;
    }
    return handler(request, user, context);
  };
}

/**
 * A 401 response, or null when the caller is signed in.
 *
 * The non-throwing form, for routes that operate on shared data and so have no
 * owner to thread through a wrapper:
 *
 * ```ts
 * const denied = await guardSession();
 * if (denied) return denied;
 * ```
 *
 * `requireUser()` throws, which is right inside `withUser` where the wrapper
 * catches it, and wrong at the top of a bare handler where an uncaught throw
 * becomes a 500. An authentication failure must read as 401.
 */
export async function guardSession(): Promise<NextResponse | null> {
  const user = await currentUser();
  return user ? null : unauthorizedResponse();
}

/**
 * The answer to a request for somebody else's row.
 *
 * 404, not 403. "You may not see this" confirms the resource exists, which is
 * itself a disclosure: an attacker walking document ids learns which ones are
 * real. A row that is not yours is indistinguishable from a row that is not
 * there, because from your account those are the same thing.
 */
export function notFoundResponse(what = "That was not found."): NextResponse {
  return NextResponse.json({ error: what }, { status: 404, headers: { "cache-control": "no-store" } });
}
