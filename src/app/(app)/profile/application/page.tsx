import Link from "next/link";
import CanonicalProfileForm from "@/components/CanonicalProfileForm";
import ProfileEntriesSection from "@/components/ProfileEntriesSection";

export const dynamic = "force-dynamic";
export const metadata = { title: "Application Autofill Profile — Internship Pilot" };

/**
 * Optional profile used only by the Application Agent.
 *
 * These fields are deliberately separated from resume matching so a user can
 * upload one resume and receive job scores without completing a long form.
 */
export default function ApplicationProfilePage() {
  return (
    <div className="max-w-4xl mx-auto px-8 py-10 space-y-10">
      <header className="space-y-2">
        <Link href="/profile" className="text-sm text-tertiary hover:text-accent-text">
          ← Back to resume profile
        </Link>
        <h1 className="text-2xl font-semibold">Application autofill profile</h1>
        <p className="text-sm text-secondary">
          Optional. Fill this out only if you want the Application Agent to answer employer-form
          fields that are not safely available from your resume. Blank answers stay blank and are
          never guessed.
        </p>
      </header>

      <CanonicalProfileForm />
      <ProfileEntriesSection />
    </div>
  );
}
