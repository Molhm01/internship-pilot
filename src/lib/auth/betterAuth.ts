import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword, MINIMUM_PASSWORD_LENGTH } from "@/lib/auth/password";

/**
 * Authentication for Internship Pilot.
 *
 * Replaces a bespoke implementation — scrypt hashing, hand-rolled session rows,
 * a cookie this project issued itself. That code was sound but it was ours to
 * keep sound forever, and it had no OAuth, no account linking, no session
 * management, and no answer for "sign me out everywhere". Better Auth owns all
 * of that now.
 *
 * Three decisions here are load-bearing.
 *
 * ## The existing User table is extended, not replaced
 *
 * Every `userId` in this schema points at `User.id`. Introducing a second
 * identity table would have meant rewriting every foreign key in the database
 * to chase a new primary key — a data migration whose failure mode is silently
 * reassigning one person's résumé to another. The Prisma adapter is pointed at
 * the tables that already exist instead, and the migration adds the columns
 * Better Auth needs to the row that already identifies the user.
 *
 * ## The old password hashes still work
 *
 * `hash` and `verify` below are the project's own scrypt functions, so the
 * value the migration copied from `User.passwordHash` into
 * `Account.password` verifies unchanged. Nobody is emailed a reset link because
 * the library that checks their password changed.
 *
 * ## Google is never linked implicitly
 *
 * See the `accountLinking` block.
 */

/** Read at call time, so a missing variable fails loudly at boot, not silently. */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Authentication cannot start without it — see DEPLOYMENT_ENVIRONMENT.md.`,
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    return new URL(candidate).origin;
  } catch {
    return null;
  }
}

/**
 * Where this deployment lives.
 *
 * Vercel sets `VERCEL_URL` per deployment, which is right for previews and
 * wrong for production (it is the deployment-specific hostname, not the stable
 * one), so an explicit `BETTER_AUTH_URL` always wins.
 */
function baseUrl(): string {
  const explicit = optional("BETTER_AUTH_URL");
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = optional("VERCEL_PROJECT_PRODUCTION_URL") ?? optional("VERCEL_URL");
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

/**
 * Better Auth validates every browser Origin header. Vercel can legitimately
 * serve the same app from the stable project URL, the production alias, and a
 * deployment-specific URL. Trust those exact hosts only; do not disable origin
 * checks and do not trust every *.vercel.app deployment globally.
 */
function trustedOrigins(): string[] {
  const candidates = [
    baseUrl(),
    optional("BETTER_AUTH_URL"),
    optional("VERCEL_PROJECT_PRODUCTION_URL"),
    optional("VERCEL_BRANCH_URL"),
    optional("VERCEL_URL"),
  ];

  const origins = candidates
    .map(normalizeOrigin)
    .filter((origin): origin is string => Boolean(origin));

  if (process.env.NODE_ENV !== "production") {
    origins.push("http://localhost:3000");
  }

  return [...new Set(origins)];
}

const googleClientId = optional("GOOGLE_CLIENT_ID");
const googleClientSecret = optional("GOOGLE_CLIENT_SECRET");

/**
 * Whether "Continue with Google" is offered at all.
 *
 * Both halves of the credential, or neither. A half-configured provider renders
 * a button that fails at the redirect, which is worse than no button.
 */
export const googleAuthConfigured = Boolean(googleClientId && googleClientSecret);

const buildAuth = () =>
  betterAuth({
    // Never `NEXT_PUBLIC_`. This secret signs session cookies; in the browser it
    // would be a session-forgery kit.
    secret: required("BETTER_AUTH_SECRET"),
    baseURL: baseUrl(),
    trustedOrigins: trustedOrigins(),
    database: prismaAdapter(prisma, { provider: "postgresql" }),

    emailAndPassword: {
      enabled: true,
      minPasswordLength: MINIMUM_PASSWORD_LENGTH,
      maxPasswordLength: 200,
      // The project's existing scrypt, so hashes written before this migration
      // still verify and hashes written after it stay in one format.
      password: {
        hash: (password) => hashPassword(password),
        verify: ({ hash, password }) => verifyPassword(password, hash),
      },
      autoSignIn: true,
    },

    socialProviders: googleAuthConfigured
      ? {
          google: {
            clientId: googleClientId!,
            clientSecret: googleClientSecret!,
          },
        }
      : {},

    account: {
      accountLinking: {
        // Linking is allowed — one human, one account, two ways in…
        enabled: true,
        // …but only when the signed-in human asks for it.
        //
        // Implicit linking merges an OAuth identity into an existing row when the
        // email matches. That is convenient and it is an account-takeover
        // primitive: anyone who can obtain an ID token for an address — or who
        // registered first at an address they do not control — inherits whatever
        // the matching local account holds, which here is somebody's résumé,
        // address, phone number and demographic answers.
        //
        // So: signing in with Google at a known address does not silently become
        // that account. It is linked from Settings, by a user who is already
        // authenticated, through `linkSocial`.
        disableImplicitLinking: true,
        // No provider is trusted to assert ownership of an address on its own.
        trustedProviders: [],
        // A linked identity must carry the same address as the account it joins.
        allowDifferentEmails: false,
        // The last remaining sign-in method may not be removed. Unlinking it
        // would leave an account with data in it and no way to reach it.
        allowUnlinkingAll: false,
        // Google's name and picture do not overwrite what the user typed here.
        updateUserInfoOnLink: false,
      },
    },

    session: {
      // Thirty days, refreshed a day at a time — the same window the previous
      // implementation used, so nobody's sign-in gets shorter because the library
      // changed.
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },

    advanced: {
      // Neither the cookie nor its contents are readable by page scripts, and
      // in production it is Secure. Better Auth sets HttpOnly and SameSite=Lax
      // by default; this is here so that stays true if a default ever changes.
      useSecureCookies: process.env.NODE_ENV === "production",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
      },
    },

    // Must be last: it is what lets Better Auth set cookies from a Next.js
    // server action or route handler.
    plugins: [nextCookies()],
  });

/**
 * Built on first use, not at import time.
 *
 * `next build` imports every route module to collect page data, and an `auth`
 * constructed at module scope would demand BETTER_AUTH_SECRET during the build
 * — turning a missing environment variable into a failed deployment instead of
 * a failed request. It also lets a unit test import a route that happens to
 * import this module without standing up a full auth configuration.
 *
 * The same reasoning, and the same shape, as the Prisma client in `lib/db.ts`.
 */
let cached: ReturnType<typeof buildAuth> | null = null;

function resolveAuth(): ReturnType<typeof buildAuth> {
  if (!cached) cached = buildAuth();
  return cached;
}

export const auth: ReturnType<typeof buildAuth> = new Proxy(
  {} as ReturnType<typeof buildAuth>,
  {
    get(_target, property, receiver) {
      const value = Reflect.get(resolveAuth(), property, receiver);
      return typeof value === "function" ? value.bind(resolveAuth()) : value;
    },
    has: (_target, property) => property in resolveAuth(),
    ownKeys: () => Reflect.ownKeys(resolveAuth()),
    getOwnPropertyDescriptor: (_target, property) =>
      Reflect.getOwnPropertyDescriptor(resolveAuth(), property),
  },
);

export type Auth = typeof auth;
