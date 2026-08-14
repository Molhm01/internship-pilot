"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LocalFirmsAliasPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/nearby");
  }, [router]);
  return null;
}
