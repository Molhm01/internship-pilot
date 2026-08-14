"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function DiagnosticsAliasPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/agent-diagnostics");
  }, [router]);
  return null;
}
