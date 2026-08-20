import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authEnvReport, emailAuthConfigured } from "@/lib/auth/diagnostics";
import { googleAuthConfigured } from "@/lib/auth/betterAuth";

/**
 * Production-safe auth diagnostics.
 *
 * Answers "is authentication able to work here?" without exposing anything
 * sensitive: no secrets, no database URL, no user data, no tokens. It reports
 * only booleans and (env) present/valid-shape, so a production failure is
 * diagnosable from a single GET instead of guessed at. Public by virtue of the
 * `/api/auth` prefix the proxy leaves open.
 */
export async function GET() {
  const env = authEnvReport();
  const authConfigured = emailAuthConfigured(env);

  let databaseReachable = false;
  let betterAuthTablesReady = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseReachable = true;
    // A trivial count against each Better Auth table proves the migration ran.
    await prisma.user.count();
    await prisma.session.count();
    await prisma.account.count();
    await prisma.verification.count();
    betterAuthTablesReady = true;
  } catch {
    // Swallow — the booleans above already carry the outcome, and the error
    // detail must not leak (it can contain the connection string).
  }

  return NextResponse.json(
    {
      authConfigured,
      databaseReachable,
      betterAuthTablesReady,
      googleConfigured: googleAuthConfigured,
      env, // present / validShape only — never values
    },
    { headers: { "cache-control": "no-store" } },
  );
}
