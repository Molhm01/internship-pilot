import { fetchJsonSafe, type AtsJob } from "@/lib/ats/types";

type LeverPosting = {
  id: string;
  text: string;
  hostedUrl: string;
  categories?: { location?: string; commitment?: string };
  workplaceType?: string;
  descriptionPlain?: string;
  createdAt?: number;
};

// Lever's public Postings API — official, documented, unauthenticated:
// https://github.com/lever/postings-api
export async function listLeverJobs(company: string, companyName: string): Promise<AtsJob[]> {
  const data = (await fetchJsonSafe(`https://api.lever.co/v0/postings/${company}?mode=json`)) as
    | LeverPosting[]
    | null;
  if (!data?.length) return [];

  return data.map((j) => ({
    sourceJobId: j.id,
    requisitionId: null,
    title: j.text,
    company: companyName,
    location: j.categories?.location ?? null,
    workplaceType: (j.workplaceType ?? "").toLowerCase() === "remote" ? "Remote" : null,
    applyUrl: j.hostedUrl,
    description: j.descriptionPlain ?? "",
    postedAt: j.createdAt ? new Date(j.createdAt) : null,
    employmentType: j.categories?.commitment ?? null,
  }));
}
