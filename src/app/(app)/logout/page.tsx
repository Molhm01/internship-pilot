"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth/client";

/**
 * Signing out is a POST performed by the auth client, so it cannot be triggered
 * by a link somebody else embeds in a page. This route performs it on arrival
 * and then says plainly that the session is gone.
 */
export default function LogoutPage() {
  const router = useRouter();
  const [done, setDone] = useState(false);

  useEffect(() => {
    void signOut().finally(() => {
      setDone(true);
      router.refresh();
    });
  }, [router]);

  return (
    <div className="max-w-md mx-auto px-8 py-16">
      <h1 className="text-2xl font-semibold">{done ? "You are signed out" : "Signing out…"}</h1>
      {done && (
        <p className="mt-4 text-sm text-secondary">
          This session has been ended on the server, not just in this browser.{" "}
          <Link href="/login" className="text-accent-text hover:underline">
            Sign in again
          </Link>
        </p>
      )}
    </div>
  );
}
