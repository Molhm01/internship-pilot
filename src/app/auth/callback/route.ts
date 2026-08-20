import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/db";

/**
 * Supabase PKCE OAuth Callback Route.
 *
 * Flow:
 * Google -> Supabase (/auth/v1/callback) -> App (/auth/callback?code=...)
 *
 * Exchanges the code for a Supabase session, upserts the user record in Prisma
 * to ensure profile and data relations stay sound, and redirects to /dashboard.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    try {
      const supabase = await createServerClient();
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);

      if (!error && data?.user?.email) {
        const user = data.user;
        const email = user.email!;
        const name =
          (user.user_metadata?.full_name as string) ||
          (user.user_metadata?.name as string) ||
          email.split("@")[0] ||
          "";
        const image = (user.user_metadata?.avatar_url as string) || (user.user_metadata?.picture as string) || null;

        // Upsert user into Prisma DB so foreign key relations (resumes, jobs, settings) stay intact
        await prisma.user.upsert({
          where: { email },
          update: {
            name,
            image: image ?? undefined,
            emailVerified: true,
          },
          create: {
            id: user.id,
            email,
            name,
            image,
            emailVerified: true,
          },
        });

        return NextResponse.redirect(`${origin}${next}`);
      }
    } catch (err) {
      console.error("Supabase OAuth callback error:", err);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
}
