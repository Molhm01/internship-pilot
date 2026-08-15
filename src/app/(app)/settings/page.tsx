import { redirect } from "next/navigation";
import AccountSettings from "@/components/settings/AccountSettings";
import { currentUser } from "@/lib/auth/session";
import { googleAuthConfigured } from "@/lib/auth/betterAuth";

export const dynamic = "force-dynamic";

export const metadata = { title: "Settings — Internship Pilot" };

/**
 * Settings.
 *
 * The session is read here, on the server, rather than fetched by the client
 * component: the page should not render an account shell for somebody who is
 * not signed in, even briefly.
 */
export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/login?next=/settings");

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <header>
        <h1 className="text-2xl font-semibold text-primary">Settings</h1>
        <p className="mt-1 text-sm text-secondary">
          Your account, how you sign in, and the devices connected to it.
        </p>
      </header>

      <AccountSettings
        name={user.name}
        email={user.email}
        googleEnabled={googleAuthConfigured}
      />
    </div>
  );
}
