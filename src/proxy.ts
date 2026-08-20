import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Route protection.
 *
 * Next 16 calls this Proxy; it is what used to be Middleware. Its job here is
 * exactly one thing: send somebody who is not signed in to the login page
 * instead of rendering an empty workspace at them.
 *
 * ## This is not the authorization layer
 *
 * It checks that a session *cookie is present and well-formed*. It does not
 * read the database, does not validate the session, and cannot tell a revoked
 * session from a live one — the framework documentation is explicit that this
 * layer is for optimistic checks, not session management, and doing a database
 * round trip in front of every asset request would be its own problem.
 *
 * Every private API route therefore authenticates independently, through
 * `requireUser()`, and every private query is filtered by the session's user
 * id. If this file were deleted the application would still be secure; a
 * signed-out visitor would simply get 401s from a page shell instead of a
 * redirect. That is the correct division: this is user experience, and
 * `src/lib/auth/session.ts` is security.
 */

/** Reachable without an account. Everything else is the signed-in workspace. */
const PUBLIC_PATHS = ["/", "/login", "/signup", "/auth/callback"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  // Better Auth's own endpoints, including the OAuth callback the browser is
  // redirected to by Google before any session exists.
  if (pathname.startsWith("/api/auth")) return true;
  return false;
}

/**
 * Development-only auth recovery (Phase 8). When DEV_AUTH_BYPASS=true AND the
 * process is not production, the cookie gate is skipped so a broken auth
 * backend cannot lock a developer out of the workspace. Inert in production by
 * construction — the NODE_ENV check is first — and it pairs with the matching
 * branch in `currentUser()`, which hands routes a real dev user so ownership
 * still works. Production authentication is untouched.
 */
function devBypassEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.DEV_AUTH_BYPASS === "true";
}

function hasSessionCookie(request: NextRequest): boolean {
  if (getSessionCookie(request)) return true;
  for (const cookie of request.cookies.getAll()) {
    if (cookie.name.startsWith("sb-") && cookie.name.endsWith("-auth-token")) {
      return true;
    }
  }
  return false;
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();
  if (devBypassEnabled()) return NextResponse.next();

  if (hasSessionCookie(request)) return NextResponse.next();

  // API routes get a 401 rather than a redirect: an HTML login page is a
  // useless response to `fetch("/api/jobs")`, and a 302 to it turns a clear
  // authentication failure into a confusing parse error.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "You need to be signed in to do that." },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const login = new URL("/login", request.url);
  // Where they were going, so signing in finishes the journey instead of
  // dumping them on the dashboard.
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  /**
   * Everything except Next's own assets and the favicon.
   *
   * Deliberately broad. An allowlist of protected paths is a list somebody
   * forgets to add a new page to, and the failure mode of forgetting is an
   * unprotected page; the failure mode of over-matching is a redirect on a
   * static file, which is visible immediately.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
