import { fetchJsonRequired, type AtsJob } from "@/lib/ats/types";

type AshbyJob = {
  id: string;
  title: string;
  jobUrl: string;
  applyUrl?: string;
  location?: string;
  isRemote?: boolean;
  employmentType?: string;
  descriptionPlain?: string;
  publishedAt?: string;
};

// Ashby's public Job Board API — official, documented, unauthenticated:
// https://developers.ashbyhq.com/docs/public-job-posting-api
export async function listAshbyJobs(boardName: string, companyName: string): Promise<AtsJob[]> {
  const data = (await fetchJsonRequired(`https://api.ashbyhq.com/posting-api/job-board/${boardName}`)) as {
    jobs?: AshbyJob[];
  };
  if (!data?.jobs?.length) return [];

  return data.jobs.map((j) => ({
    sourceJobId: j.id,
    requisitionId: null,
    title: j.title,
    company: companyName,
    location: j.location ?? null,
    workplaceType: j.isRemote ? "Remote" : null,
    applyUrl: j.applyUrl ?? j.jobUrl,
    description: j.descriptionPlain ?? "",
    postedAt: j.publishedAt ? new Date(j.publishedAt) : null,
    employmentType: j.employmentType ?? null,
  }));
}
