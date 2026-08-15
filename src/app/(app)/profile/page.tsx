import Link from "next/link";
import CanonicalProfileForm from "@/components/CanonicalProfileForm";
import ProfileEntriesSection from "@/components/ProfileEntriesSection";
import ResumeFactsSection from "@/components/ResumeFactsSection";

/** Per request: the page renders one signed-in person's own profile. */
export const dynamic = "force-dynamic";

export const metadata = { title: "Profile — Internship Pilot" };

/**
 * The Profile page.
 *
 * Everything the Application Agent fills an employer form from lives here, and
 * nothing else does. A blank field stays blank on the form — it is never
 * guessed, defaulted, or inferred from a neighbouring value.
 *
 * Reaching this page at all requires a session; the data on it is fetched
 * per-user by the profile APIs, which authenticate independently.
 */
export default function ProfilePage() {
  return (
    <div className="max-w-4xl mx-auto px-8 py-10 space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Your profile</h1>
        <p className="mt-1 text-sm text-secondary">
          The Application Agent fills employer forms from this. Anything left blank is left blank on
          the form too — it is never guessed.
        </p>
      </header>

      <CanonicalProfileForm />

      <ProfileEntriesSection />

      <div className="border-t border-hairline pt-8">
        <h2 className="text-lg font-semibold text-primary">Résumé facts</h2>
        <p className="mt-1 text-sm text-secondary">
          Extracted from your uploaded résumé and used for tailored document generation. Structured
          experience and project entries above take precedence when an employer form asks for an
          employer, a title and dates as separate answers.
        </p>
        <div className="mt-4">
          <ResumeFactsSection />
        </div>
      </div>

      <p className="text-sm text-tertiary">
        Cover letters and the reusable bullet library live on the{" "}
        <Link href="/documents" className="text-accent-text hover:underline">
          Documents page
        </Link>
        .
      </p>
    </div>
  );
}
