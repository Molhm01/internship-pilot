"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function NeedsReviewPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/jobs");
  }, [router]);
  return null;
}
