import AuthForm from "@/components/AuthForm";
import { googleAuthConfigured } from "@/lib/auth/betterAuth";

/** Per request, so the Google button appears the moment the provider is configured. */
export const dynamic = "force-dynamic";

export const metadata = { title: "Log in — Internship Pilot" };

export default function LoginPage() {
  return <AuthForm mode="login" googleEnabled={googleAuthConfigured} />;
}
