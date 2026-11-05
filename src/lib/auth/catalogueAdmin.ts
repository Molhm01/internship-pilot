/**
 * Catalogue-write guard.
 *
 * Company rows are shared infrastructure, not per-user data, so "any
 * signed-in account" is not sufficient authority to mutate them. Writes are
 * limited to the deployment owner's account(s), named by the
 * CATALOGUE_ADMIN_EMAILS environment variable (comma-separated,
 * case-insensitive). Fails closed: with no allowlist configured, nobody can
 * mutate the catalogue through the API.
 */
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";

export async function isCatalogueAdmin(): Promise<boolean> {
  const user = await currentUser();
  if (!user?.email) return false;
  const allowed = (process.env.CATALOGUE_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(user.email.toLowerCase());
}

export async function requireCatalogueAdmin(): Promise<NextResponse | null> {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isCatalogueAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}
