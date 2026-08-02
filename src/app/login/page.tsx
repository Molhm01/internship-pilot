import { notFound } from "next/navigation";
import AuthForm from "@/components/AuthForm";
import { isWebsiteAuthEnabled } from "@/lib/singleUser";

export const metadata = { title: "Log in — Internship Pilot" };

/**
 * Kept for the multi-user release and hidden in local mode.
 *
 * In single-user mode there is nothing to log into, and a reachable login page
 * would imply the profile sits behind it — exactly the confusion this
 * deployment mode exists to remove.
 */
export default function LoginPage() {
  if (!isWebsiteAuthEnabled()) notFound();
  return <AuthForm mode="login" />;
}
