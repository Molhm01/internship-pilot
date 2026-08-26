import { Suspense } from "react";
import AuthForm from "@/components/AuthForm";
import { googleAuthConfigured } from "@/lib/auth/betterAuth";

/** Per request, so the Google button appears the moment the provider is configured. */
export const dynamic = "force-dynamic";

export const metadata = { title: "Create your account — Internship Pilot" };

export default function SignupPage() {
  // AuthForm reads the `next` redirect target via useSearchParams(), which
  // requires a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <AuthForm mode="signup" googleEnabled={googleAuthConfigured} />
    </Suspense>
  );
}
