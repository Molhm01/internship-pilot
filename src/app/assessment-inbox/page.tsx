"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AssessmentInboxAliasPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/assessments");
  }, [router]);
  return null;
}
