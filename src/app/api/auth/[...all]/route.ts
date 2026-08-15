import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/betterAuth";

/**
 * Every authentication endpoint: sign-up, sign-in, sign-out, the Google
 * redirect and its callback, session lookup, account linking, session
 * revocation.
 *
 * One catch-all rather than a folder of hand-written routes. The previous
 * implementation had four (`/login`, `/signup`, `/logout`, `/me`), and each one
 * was a place where a cookie flag or a session check could be written slightly
 * differently from the other three.
 *
 * The handler is wrapped in an arrow rather than passed as `auth.handler`, so
 * the auth instance is constructed on the first request instead of when this
 * module is imported. `next build` imports every route to collect page data,
 * and reading `.handler` at module scope would demand BETTER_AUTH_SECRET during
 * the build — turning a missing environment variable into a failed deployment
 * rather than a failed request with a message that names it. Same reasoning as
 * the lazy Prisma client in `lib/db.ts`.
 */
export const { GET, POST } = toNextJsHandler((request: Request) => auth.handler(request));
