import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session";
import ProfileSections from "@/components/ProfileSections";
import ResumeFactsSection from "@/components/ResumeFactsSection";

export const metadata = { title: "Profile — Internship Pilot" };

/**
 * The Profile page.
 *
 * Server-rendered behind the session so an unauthenticated visitor is redirected
 * rather than shown an empty form that silently fails to save. The résumé-fact
 * review that used to live at this path is kept below the canonical profile —
 * it feeds document generation and is unchanged.
 */
export default async function ProfilePage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <div className="max-w-4xl mx-auto px-8 py-10 space-y-10">
      <header className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-semibold">Your profile</h1>
          <p className="mt-1 text-sm text-slate-600">
            Signed in as {user.displayName ? `${user.displayName} · ` : ""}
            {user.email}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            The Application Agent fills employer forms from this. Anything left blank is left blank
            on the form too — it is never guessed.
          </p>
        </div>
        <Link
          href="/logout"
          className="shrink-0 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Log out
        </Link>
      </header>

      <ProfileSections />

      <div className="border-t border-slate-200 pt-8">
        <h2 className="text-lg font-semibold text-slate-900">Résumé facts</h2>
        <p className="mt-1 text-sm text-slate-600">
          Extracted from your uploaded résumé and used for tailored document generation.
        </p>
        <div className="mt-4">
          <ResumeFactsSection />
        </div>
      </div>
    </div>
  );
}
