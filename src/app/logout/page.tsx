"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * Logging out is a POST, so it cannot be triggered by a link someone else
 * embeds. This page performs it on arrival and then says plainly that the
 * session is gone.
 */
export default function LogoutPage() {
  const router = useRouter();
  const [done, setDone] = useState(false);

  useEffect(() => {
    void fetch("/api/auth/logout", { method: "POST" }).then(() => {
      setDone(true);
      router.refresh();
    });
  }, [router]);

  return (
    <div className="max-w-md mx-auto px-8 py-16">
      <h1 className="text-2xl font-semibold">{done ? "You are logged out" : "Logging out…"}</h1>
      {done && (
        <p className="mt-4 text-sm text-slate-600">
          Your session has been ended.{" "}
          <Link href="/login" className="text-brand hover:underline">Log in again</Link>
        </p>
      )}
    </div>
  );
}
