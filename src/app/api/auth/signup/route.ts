import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { websiteAuthDisabledResponse } from "@/lib/auth/mode";
import { hashPassword, normalizeEmail, passwordProblem } from "@/lib/auth/password";
import { createSession, setSessionCookie } from "@/lib/auth/session";

/**
 * Creates an Internship Pilot account.
 *
 * The response contains the account's id, email and display name and nothing
 * else — never the hash, never the password, never the session row.
 */
export async function POST(request: Request) {
  const disabled = websiteAuthDisabledResponse();
  if (disabled) return disabled;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });

  const email = normalizeEmail(body.email);
  if (!email) {
    return NextResponse.json(
      { error: "Enter a valid email address.", field: "email" },
      { status: 422 },
    );
  }
  const password = typeof body.password === "string" ? body.password : "";
  const confirmation = typeof body.confirmPassword === "string" ? body.confirmPassword : undefined;
  const problem = passwordProblem(password, confirmation);
  if (problem) {
    return NextResponse.json(
      { error: problem, field: confirmation !== undefined && password !== confirmation ? "confirmPassword" : "password" },
      { status: 422 },
    );
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json(
      { error: "An account already exists for that email address.", field: "email" },
      { status: 409 },
    );
  }

  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      displayName: displayName || null,
      // A new account starts with the demographic decline the spec asks for,
      // and with nothing else assumed.
      sensitivePreferences: { create: { declineDemographics: true } },
      profile: { create: { applicationEmail: email } },
    },
  });

  await setSessionCookie(await createSession(user.id));
  return NextResponse.json(
    { user: { id: user.id, email: user.email, displayName: user.displayName } },
    { status: 201 },
  );
}
