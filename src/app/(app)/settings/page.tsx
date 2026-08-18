import SettingsClient from "@/components/settings/SettingsClient";
import { googleAuthConfigured } from "@/lib/auth/betterAuth";

export const dynamic = "force-dynamic";

export const metadata = { title: "Settings — Internship Pilot" };

/**
 * Settings is an interactive client surface. Route protection remains in the
 * workspace proxy and every API called by the screen authenticates itself.
 * Avoiding a second Better Auth database/session lookup during the server render
 * means a transient auth lookup can no longer take the whole page down with a
 * server-render 500.
 */
export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <header>
        <h1 className="text-2xl font-semibold text-primary">Settings</h1>
        <p className="mt-1 text-sm text-secondary">
          Your account, how you sign in, connected devices, and live internship discovery.
        </p>
      </header>

      <SettingsClient googleEnabled={googleAuthConfigured} />
    </div>
  );
}
