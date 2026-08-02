import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { isSingleUserMode } from "@/lib/singleUser";

/**
 * Who is signed in, or an explicit statement that the question does not apply.
 *
 * `singleUserMode` is returned rather than a bare `user: null` so the sidebar
 * can tell "nobody is signed in" from "there is nothing to sign in to", and
 * stop offering a login this deployment does not have.
 */
export async function GET() {
  if (isSingleUserMode()) {
    return NextResponse.json(
      { user: null, singleUserMode: true },
      { headers: { "cache-control": "no-store" } },
    );
  }
  return NextResponse.json(
    { user: await currentUser(), singleUserMode: false },
    { headers: { "cache-control": "no-store" } },
  );
}
