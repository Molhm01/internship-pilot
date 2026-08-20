import Link from "next/link";
import CanonicalProfileForm from "@/components/CanonicalProfileForm";
import ProfileEntriesSection from "@/components/ProfileEntriesSection";

export const dynamic = "force-dynamic";

export const metadata = { title: "Application profile — Internship Pilot" };

/**
 * Optional employer-form profile used by the Application Agent.
 *
 * This is intentionally separate from the resume-first matching flow. A user
 * can upload one resume and get ATS-ranked jobs without completing any of these
 * fields. When they choose to use autofill, this page provides the exact values
 * the agent may place into employer forms; blank fields remain blank and are
 * never guessed.
 */
export default function ApplicationProfilePage() {
  return (
    <div className="max-w-4xl mx-auto px-8 py-10 space-y-10">
      <header>
        <Link href="/profile" className="text-sm text-accent-text hover:underline">
          ← Back to resume
        </Link>
        <h1 className="mt-3 text-2xl font-semibold">Application autofill profile</h1>
        <p className="mt-1 text-sm text-secondary max-w-3xl">
          Optional. The Application Agent uses these exact values when an employer form asks for
          personal, education, work-authorization, demographic, experience, or project details.
          Anything left blank stays blank unless the application can be answered directly from your
          resume evidence.
        </p>
      </header>

      <CanonicalProfileForm />
      <ProfileEntriesSection />

      <p className="text-sm text-tertiary">
        Resume-derived ATS evidence is managed on the{" "}
        <Link href="/profile" className="text-accent-text hover:underline">
          Resume page
        </Link>
        .
      </p>
    </div>
  );
}
