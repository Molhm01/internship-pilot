import type { AtsJob } from "@/lib/ats/types";
import { crawlStructuredPortalJobs } from "@/lib/ats/structuredCareer";

export async function listIcimsJobs(
  atsIdentifier: string,
  careersUrl: string,
  companyName: string,
): Promise<AtsJob[]> {
  const startUrls = new Set<string>();
  if (atsIdentifier && /^[a-z0-9-]+$/i.test(atsIdentifier)) {
    startUrls.add(`https://${atsIdentifier}.icims.com/jobs/search?ss=1`);
  }

  return crawlStructuredPortalJobs({
    kind: "icims",
    companyName,
    careersUrl,
    additionalStartUrls: [...startUrls],
    maxListPages: 6,
    maxJobDetails: 35,
  });
}
