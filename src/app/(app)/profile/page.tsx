import Link from "next/link";
import ResumeFactsSection from "@/components/ResumeFactsSection";
import { PageBody } from "@/components/ui/PageHeader";

/** Per request: the page renders one signed-in person's own resume evidence. */
export const dynamic = "force-dynamic";

export const metadata = { title: "Resume — Internship Pilot" };

export default function ProfilePage() {
  return (
    <PageBody className="space-y-8">
      <ResumeFactsSection />

      <div className="border-t border-hairline pt-6">
        <p className="text-small text-tertiary">
          Your uploaded resume automatically powers 100% ATS match scoring and tailored PDF
          generation across every fresh internship. Optional portal defaults can also be tuned in{" "}
          <Link href="/profile/application" className="text-accent-text hover:underline">
            application preferences
          </Link>
          .
        </p>
      </div>
    </PageBody>
  );
}
