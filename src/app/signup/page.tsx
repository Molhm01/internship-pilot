import { notFound } from "next/navigation";
import AuthForm from "@/components/AuthForm";
import { isWebsiteAuthEnabled } from "@/lib/singleUser";

/**
 * Rendered per request so INTERNSHIP_PILOT_SINGLE_USER is read when the page is
 * asked for rather than baked in at build time. Otherwise switching deployment
 * mode would need a rebuild, and a statically-404'd /login could never return.
 */
export const dynamic = "force-dynamic";

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
