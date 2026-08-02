import { NextResponse } from "next/server";
import { isWebsiteAuthEnabled } from "@/lib/singleUser";

/**
 * The guard every website-authentication route sits behind.
 *
 * In local single-user mode there are no accounts, so these routes must not
 * half-work: a signup endpoint that creates a `User` nobody can reach, or a
 * `/api/auth/me` that answers `null` and makes the sidebar offer a pointless
 * "Log in" link, are both worse than an honest refusal.
 *
 * Returns a 404 rather than a 403 because in this deployment the feature does
 * not exist, as opposed to existing and being denied.
 */
export function websiteAuthDisabledResponse(): NextResponse | null {
  if (isWebsiteAuthEnabled()) return null;
  return NextResponse.json(
    {
      error:
        "Internship Pilot is running in local single-user mode, where there are no accounts. Your profile is at /profile and needs no sign-in.",
      singleUserMode: true,
    },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}
