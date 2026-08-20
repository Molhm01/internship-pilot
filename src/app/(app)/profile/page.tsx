import Link from "next/link";
import ResumeFactsSection from "@/components/ResumeFactsSection";

/** Per request: the page renders one signed-in person's own resume evidence. */
export const dynamic = "force-dynamic";

export const metadata = { title: "Resume — Internship Pilot" };

/**
 * Resume-first profile.
 *
 * The default onboarding surface is intentionally small: one resume becomes
 * the evidence used for automatic ATS matching. The much larger employer-form
 * profile still exists, but it is optional and lives under /profile/application
 * so users do not have to complete an autofill questionnaire before seeing
 * personalized job matches.
 */
export default function ProfilePage() {
  return (
    <div className="max-w-4xl mx-auto px-8 py-10 space-y-8">
      <ResumeFactsSection />

      <div className="border-t border-hairline pt-6">
        <p className="text-sm text-tertiary">
          Only using Internship Pilot for job matching? You&apos;re done after uploading your resume.
          If you want the Application Agent to fill employer forms later, configure the optional{" "}
          <Link href="/profile/application" className="text-accent-text hover:underline">
            application autofill profile
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
