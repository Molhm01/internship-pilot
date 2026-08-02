import { fetchJsonSafe, type AtsJob } from "@/lib/ats/types";

type GreenhouseJob = {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  content?: string;
  updated_at?: string;
  requisition_id?: string;
};

// Greenhouse's public Job Board API — official, documented, unauthenticated:
// https://developers.greenhouse.io/job-board.html
export async function listGreenhouseJobs(boardToken: string, companyName: string): Promise<AtsJob[]> {
  const data = (await fetchJsonSafe(
    `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs?content=true`,
  )) as { jobs?: GreenhouseJob[] } | null;
  if (!data?.jobs?.length) return [];

  return data.jobs.map((j) => ({
    sourceJobId: String(j.id),
    requisitionId: j.requisition_id ?? null,
    title: j.title,
    company: companyName,
    location: j.location?.name ?? null,
    workplaceType: /remote/i.test(j.location?.name ?? "") ? "Remote" : null,
    applyUrl: j.absolute_url,
    description: j.content ?? "",
    postedAt: j.updated_at ? new Date(j.updated_at) : null,
  }));
}
