/**
 * Safe authentication diagnostics.
 *
 * Reports whether each required piece of configuration is PRESENT and
 * SHAPED correctly — never its value. This is what lets a production auth
 * failure be diagnosed from `/api/auth/health` instead of guessed at. Nothing
 * here returns a secret, a URL, a token, or any user data.
 */

export type VarStatus = {
  present: boolean;
  /** Whether the value looks structurally valid (never the value itself). */
  validShape: boolean;
  /** A short, non-sensitive note, e.g. "must be https in production". */
  note?: string;
};

function raw(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function status(present: boolean, validShape: boolean, note?: string): VarStatus {
  return note ? { present, validShape, note } : { present, validShape };
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const isProd = () => process.env.NODE_ENV === "production";

export type AuthEnvReport = {
  BETTER_AUTH_SECRET: VarStatus;
  BETTER_AUTH_URL: VarStatus;
  DATABASE_URL: VarStatus;
  GOOGLE_CLIENT_ID: VarStatus;
  GOOGLE_CLIENT_SECRET: VarStatus;
};

/** Names-and-shape only. Safe to expose. */
export function authEnvReport(): AuthEnvReport {
  const secret = raw("BETTER_AUTH_SECRET");
  const url = raw("BETTER_AUTH_URL");
  const vercelProd = raw("VERCEL_PROJECT_PRODUCTION_URL");
  const db = raw("DATABASE_URL");
  const gid = raw("GOOGLE_CLIENT_ID");
  const gsecret = raw("GOOGLE_CLIENT_SECRET");

  return {
    // A signing secret shorter than ~16 chars is a real weakness; flag shape.
    BETTER_AUTH_SECRET: status(Boolean(secret), Boolean(secret && secret.length >= 16), secret && secret.length < 16 ? "too short" : undefined),
    // In production a stable https base URL must be resolvable — either
    // BETTER_AUTH_URL or Vercel's stable production URL. localhost in prod is
    // the classic "works in preview, breaks the cookie" misconfiguration.
    BETTER_AUTH_URL: (() => {
      const effective = url ?? (vercelProd ? `https://${vercelProd}` : undefined);
      const present = Boolean(effective);
      if (!present) return status(false, false, isProd() ? "set BETTER_AUTH_URL to the stable production origin" : undefined);
      const httpsOk = !isProd() || effective!.startsWith("https://");
      const localhostInProd = isProd() && /localhost|127\.0\.0\.1/.test(effective!);
      return status(true, isHttpUrl(effective!) && httpsOk && !localhostInProd, localhostInProd ? "must not be localhost in production" : !httpsOk ? "must be https in production" : undefined);
    })(),
    DATABASE_URL: status(Boolean(db), Boolean(db && /^postgres(ql)?:\/\//.test(db)), db && !/^postgres(ql)?:\/\//.test(db) ? "must be a postgres:// URL" : undefined),
    // Both halves of the Google credential, or neither. A half-configured
    // provider renders a button that fails at the redirect.
    GOOGLE_CLIENT_ID: status(Boolean(gid), Boolean(gid && gid.endsWith(".apps.googleusercontent.com")), gid && !gid.endsWith(".apps.googleusercontent.com") ? "unexpected client id format" : undefined),
    GOOGLE_CLIENT_SECRET: status(Boolean(gsecret), Boolean(gsecret && gsecret.length >= 10)),
  };
}

/** True when email/password auth has everything it needs. Google is optional. */
export function emailAuthConfigured(report: AuthEnvReport = authEnvReport()): boolean {
  return (
    report.BETTER_AUTH_SECRET.present &&
    report.BETTER_AUTH_SECRET.validShape &&
    report.DATABASE_URL.present &&
    report.DATABASE_URL.validShape &&
    // In production the base URL must be sound; in dev the localhost fallback is fine.
    (process.env.NODE_ENV !== "production" || (report.BETTER_AUTH_URL.present && report.BETTER_AUTH_URL.validShape))
  );
}
