import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { websiteAuthDisabledResponse } from "@/lib/auth/mode";
import { normalizeEmail, verifyPassword } from "@/lib/auth/password";
import { createSession, pruneExpiredSessions, setSessionCookie } from "@/lib/auth/session";

export async function POST(request: Request) {
  const disabled = websiteAuthDisabledResponse();
  if (disabled) return disabled;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });

  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";

  // One message for both a missing account and a wrong password: saying which
  // is wrong tells an attacker which emails are registered.
  const rejection = NextResponse.json(
    { error: "That email address and password do not match an account." },
    { status: 401 },
  );
  if (!email || !password) return rejection;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return rejection;
  if (!(await verifyPassword(password, user.passwordHash))) return rejection;

  await pruneExpiredSessions();
  await setSessionCookie(await createSession(user.id));
  return NextResponse.json({
    user: { id: user.id, email: user.email, displayName: user.displayName },
  });
}
