import { createServerClient as createClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Shared server-side Supabase client for Next.js App Router.
 *
 * Reads and sets cookies securely using `next/headers`.
 */
export async function createServerClient() {
  const cookieStore = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key";

  return createClient(url, anonKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // Called from Server Components: cookie changes are ignored if already streaming.
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value: "", ...options });
        } catch {
          // Called from Server Components.
        }
      },
    },
  });
}
