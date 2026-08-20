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
const PUBLIC_PATHS = ["/", "/login", "/signup"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  // Better Auth's own endpoints, including the OAuth callback the browser is
  // redirected to by Google before any session exists.
  if (pathname.startsWith("/api/auth")) return true;
  // The extension compatibility/local-supervisor health handshake is
  // intentionally public and returns only version/build constants. `npm run
  // local` uses this endpoint before any user has signed in, so protecting it
  // creates a false startup timeout even while the server is healthy.
  if (pathname === "/api/extension/health") return true;
  // Aggregate-only production health/coverage diagnostics. These endpoints
  // expose counts/timestamps only — never user data, job details, credentials,
  // or secrets.
  if (pathname === "/api/health/catalog" || pathname.startsWith("/api/health/catalog/")) return true;
  // Vercel invokes cron routes without a user session cookie. These handlers
  // authenticate themselves with CRON_SECRET, so the proxy must let the
  // request reach the route instead of replacing it with the normal API 401.
  if (pathname.startsWith("/api/cron/")) return true;
  return false;
}

function normalizeOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).origin;
  } catch {
    return null;
  }
}

/**
 * A Better Auth session cookie belongs to one hostname. Vercel also gives every
 * production deployment its own immutable hostname, so opening those generated
 * URLs creates a second browser cookie jar and makes a valid login look "lost".
 *
 * In production, Vercel's own stable project-production URL is the source of
 * truth. `BETTER_AUTH_URL` remains a fallback for non-Vercel/self-hosted installs,
 * but it must never be allowed to redirect a healthy Vercel production domain
 * to an old immutable deployment URL.
 */
function canonicalProductionOrigin(): string | null {
  if (process.env.VERCEL_ENV !== "production") return null;
  return (
    normalizeOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL)
    ?? normalizeOrigin(process.env.BETTER_AUTH_URL)
  );
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const canonicalOrigin = canonicalProductionOrigin();
  if (
    canonicalOrigin
    && !pathname.startsWith("/api/")
    && request.nextUrl.origin !== canonicalOrigin
  ) {
    return NextResponse.redirect(new URL(`${pathname}${search}`, canonicalOrigin), 308);
  }

  if (isPublic(pathname)) return NextResponse.next();

  const cookie = getSessionCookie(request);
  if (cookie) return NextResponse.next();

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
