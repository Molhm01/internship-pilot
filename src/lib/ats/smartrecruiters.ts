import { fetchJsonSafe, type AtsJob } from "@/lib/ats/types";

type SmartRecruitersPosting = {
  id: string;
  name: string;
  refNumber?: string;
  releasedDate?: string;
  location?: { fullLocation?: string; remote?: boolean; hybrid?: boolean };
  department?: { label?: string };
  function?: { label?: string };
};

function flattenJobAdText(jobAd?: {
  sections?: Record<string, { title?: string; text?: string }>;
}): string {
  if (!jobAd?.sections) return "";
  return Object.values(jobAd.sections)
    .map((s) => (s?.text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

// SmartRecruiters' public Postings API — official, documented, unauthenticated:
// https://developers.smartrecruiters.com/docs/job-api
export async function listSmartRecruitersJobs(companyId: string, companyName: string): Promise<AtsJob[]> {
  const data = (await fetchJsonSafe(
    `https://api.smartrecruiters.com/v1/companies/${companyId}/postings?limit=100`,
  )) as { content?: SmartRecruitersPosting[] } | null;
  if (!data?.content?.length) return [];

  const jobs: AtsJob[] = [];
  for (const p of data.content) {
    const detail = (await fetchJsonSafe(
      `https://api.smartrecruiters.com/v1/companies/${companyId}/postings/${p.id}`,
    )) as { postingUrl?: string; applyUrl?: string; jobAd?: Parameters<typeof flattenJobAdText>[0] } | null;

    const description =
      flattenJobAdText(detail?.jobAd) ||
      [p.department?.label, p.function?.label].filter(Boolean).join(" — ");

    jobs.push({
      sourceJobId: p.id,
      requisitionId: p.refNumber ?? null,
      title: p.name,
      company: companyName,
      location: p.location?.fullLocation ?? null,
      workplaceType: p.location?.remote ? "Remote" : p.location?.hybrid ? "Hybrid" : null,
      applyUrl: detail?.applyUrl ?? detail?.postingUrl ?? `https://jobs.smartrecruiters.com/${companyId}/${p.id}`,
      description,
      postedAt: p.releasedDate ? new Date(p.releasedDate) : null,
    });
  }
  return jobs;
}
