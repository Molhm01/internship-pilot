import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/betterAuth";
import { prisma } from "@/lib/db";

/**
 * Who is asking.
 *
 * When `REQUIRE_AUTH !== "true"` (default autonomous/single-workspace mode in
 * both cloud and local runs), visitors receive the shared workspace identity
 * without a forced login wall. When a Better Auth session cookie IS present,
 * that signed-in user takes precedence.
 */

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  image: string | null;
  emailVerified: boolean;
};

export const WORKSPACE_USER: SessionUser = {
  id: process.env.APPLICATION_WORKER_USER_ID?.trim() || "pilot-workspace-user",
  email: "pilot@internshippilot.local",
  name: "Internship Pilot",
  image: null,
  emailVerified: true,
};

let workspaceUserEnsured = false;

export async function ensureWorkspaceUser(): Promise<SessionUser> {
  if (!workspaceUserEnsured) {
    try {
      await prisma.user.upsert({
        where: { id: WORKSPACE_USER.id },
        create: {
          id: WORKSPACE_USER.id,
          email: WORKSPACE_USER.email,
          name: WORKSPACE_USER.name,
          displayName: WORKSPACE_USER.name,
          emailVerified: true,
        },
        update: {},
      });
      workspaceUserEnsured = true;
    } catch (err) {
      // Fallback: look up by email in case a user already claimed this email
      const byEmail = await prisma.user.findUnique({ where: { email: WORKSPACE_USER.email } }).catch(() => null);
      if (byEmail) {
        workspaceUserEnsured = true;
        return {
          id: byEmail.id,
          email: byEmail.email,
          name: byEmail.name ?? WORKSPACE_USER.name,
          image: byEmail.image ?? null,
          emailVerified: Boolean(byEmail.emailVerified),
        };
      }
      console.warn("[auth] ensureWorkspaceUser non-fatal:", err instanceof Error ? err.message : String(err));
    }
  }
  return WORKSPACE_USER;
}

/**
 * The signed-in user, or the default autonomous workspace user (unless REQUIRE_AUTH=true).
 */
export async function currentUser(): Promise<SessionUser | null> {
  const strictAuth = process.env.REQUIRE_AUTH === "true";
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (session?.user) {
      return {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name ?? "",
        image: session.user.image ?? null,
        emailVerified: Boolean(session.user.emailVerified),
      };
    }
  } catch (error) {
    if (strictAuth) throw error;
  }
  if (strictAuth) return null;
  return ensureWorkspaceUser();
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

type SessionInfrastructureCode =
  | "AUTH_NOT_CONFIGURED"
  | "DATABASE_URL_MISSING"
  | "DATABASE_SCHEMA_NOT_READY"
  | "DATABASE_UNAVAILABLE"
  | "SESSION_LOOKUP_FAILED";

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code ? code : null;
}

/**
 * Convert an auth/session infrastructure crash into a safe machine-readable
 * response. No database URL, SQL text, cookie, email address, or provider body
 * is returned to the browser. The exact exception remains server-side only.
 */
function sessionInfrastructureResponse(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  const prismaCode = errorCode(error);
  let code: SessionInfrastructureCode = "SESSION_LOOKUP_FAILED";
  let publicMessage = "The signed-in session could not be loaded. Please try again shortly.";

  if (/BETTER_AUTH_SECRET.*not set/i.test(message)) {
    code = "AUTH_NOT_CONFIGURED";
    publicMessage = "Authentication is not configured for this deployment.";
  } else if (/DATABASE_URL.*not set|DATABASE_URL_MISSING/i.test(message)) {
    code = "DATABASE_URL_MISSING";
    publicMessage = "The production database is not connected to this deployment.";
  } else if (
    prismaCode === "P2021"
    || prismaCode === "P2022"
    || /table .* does not exist|relation .* does not exist|column .* does not exist/i.test(message)
  ) {
    code = "DATABASE_SCHEMA_NOT_READY";
    publicMessage = "The production database schema is behind the deployed application. A database migration is required.";
  } else if (
    (prismaCode?.startsWith("P1") ?? false)
    || /ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection.*(?:closed|timeout|refused)|too many connections/i.test(message)
  ) {
    code = "DATABASE_UNAVAILABLE";
    publicMessage = "The production database is temporarily unavailable.";
  }

  console.error("[auth] session infrastructure failure", {
    code,
    errorName: error instanceof Error ? error.name : typeof error,
    prismaCode: prismaCode ?? "NONE",
  });

  return NextResponse.json(
    { error: publicMessage, code },
    { status: 503, headers: { "cache-control": "no-store" } },
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
 * a 500. Infrastructure failures become a sanitized 503 instead of escaping as
 * an opaque framework error.
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
      return sessionInfrastructureResponse(error);
    }
    return handler(request, user, context);
  };
}

/**
 * A 401 response, an infrastructure 503, or null when the caller is signed in.
 *
 * The non-throwing form, for routes that operate on shared data and so have no
 * owner to thread through a wrapper:
 *
 * ```ts
 * const denied = await guardSession();
 * if (denied) return denied;
 * ```
 */
export async function guardSession(): Promise<NextResponse | null> {
  try {
    const user = await currentUser();
    return user ? null : unauthorizedResponse();
  } catch (error) {
    return sessionInfrastructureResponse(error);
  }
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
