import type { AtsJob } from "@/lib/ats/types";
import { crawlStructuredPortalJobs } from "@/lib/ats/structuredCareer";

export async function listSuccessFactorsJobs(
  careersUrl: string,
  companyName: string,
): Promise<AtsJob[]> {
  return crawlStructuredPortalJobs({
    kind: "successfactors",
    companyName,
    careersUrl,
    maxListPages: 8,
    maxJobDetails: 40,
  });
}
