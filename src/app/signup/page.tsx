import { notFound } from "next/navigation";
import AuthForm from "@/components/AuthForm";
import { isWebsiteAuthEnabled } from "@/lib/singleUser";

export const metadata = { title: "Create account — Internship Pilot" };

/**
 * Internship Pilot account creation — not employer-portal account creation,
 * which lives in the extension and is the feature this product actually needs.
 * Hidden in local single-user mode; kept for the multi-user release.
 */
export default function SignupPage() {
  if (!isWebsiteAuthEnabled()) notFound();
  return <AuthForm mode="signup" />;
}
