import Link from "next/link";
import ResumeFactsSection from "@/components/ResumeFactsSection";

export const dynamic = "force-dynamic";
export const metadata = { title: "Resume Profile — Internship Pilot" };

/**
 * Resume-first profile.
 *
 * ATS/job matching intentionally starts from one artifact: the user's resume.
 * The much larger application-autofill questionnaire still exists, but it is
 * optional and lives on its own page so it never blocks discovery or scoring.
 */
export default function ProfilePage() {
  return (
    <div className="max-w-4xl mx-auto px-8 py-10 space-y-8">
      <ResumeFactsSection />

      <div className="border-t border-hairline pt-5">
        <p className="text-sm text-tertiary">
          Only using Internship Pilot for job matching? You are done after uploading your resume.
          If you later want the Application Agent to fill employer forms, configure the optional{" "}
          <Link href="/profile/application" className="text-accent-text hover:underline">
            application autofill profile
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
