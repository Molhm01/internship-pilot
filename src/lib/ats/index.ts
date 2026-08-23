import type { AtsJob } from "@/lib/ats/types";
import { listGreenhouseJobs } from "@/lib/ats/greenhouse";
import { listLeverJobs } from "@/lib/ats/lever";
import { listAshbyJobs } from "@/lib/ats/ashby";
import { listSmartRecruitersJobs } from "@/lib/ats/smartrecruiters";
import { listWorkdayJobs } from "@/lib/ats/workday";
import { listIcimsJobs } from "@/lib/ats/icims";
import { listSuccessFactorsJobs } from "@/lib/ats/successfactors";
import { listEightfoldJobs } from "@/lib/ats/eightfold";
import { listPhenomJobs } from "@/lib/ats/phenom";
import { listSpaEmbeddedJobs } from "@/lib/ats/spaDiscovery";
import { listEmployerPageJobs } from "@/lib/ats/employerPageLinks";
import { scanCareersPageForInternshipLinks } from "@/lib/ats/generic";

export * from "@/lib/ats/types";
export * from "@/lib/ats/detect";

const TARGET_KEYWORDS =
  /intern|co-?op|undergrad|student\s+(engineer|role|position)|engineering\s+technician/i;

export type CompanyForListing = {
  name: string;
  atsType: string | null;
  atsIdentifier: string | null;
  careersUrl: string | null;
  lastETag?: string | null;
  lastModified?: string | null;
  contentHash?: string | null;
};

export type ListJobsResult = {
  jobs: AtsJob[];
  supported: boolean;
  notModified?: boolean;
  etag?: string | null;
  lastModified?: string | null;
  contentHash?: string | null;
};

// Every supported ATS type dispatches here. Returns { jobs, supported } —
// `supported: false` means we have no working adapter for this company yet
// (honest signal, not an error) so callers can distinguish "checked, found
// nothing" from "can't check this one automatically." For the remaining
// generic scan path, `notModified: true` means the page did not change and
// ingestion can be skipped for that cycle.
export async function listJobsForCompany(company: CompanyForListing): Promise<ListJobsResult> {
  const id = company.atsIdentifier;
  switch (company.atsType) {
    case "greenhouse":
      if (!id) return { jobs: [], supported: false };
      return { jobs: await listGreenhouseJobs(id, company.name), supported: true };
    case "lever":
      if (!id) return { jobs: [], supported: false };
      return { jobs: await listLeverJobs(id, company.name), supported: true };
    case "ashby":
      if (!id) return { jobs: [], supported: false };
      return { jobs: await listAshbyJobs(id, company.name), supported: true };
    case "smartrecruiters":
      if (!id) return { jobs: [], supported: false };
      return { jobs: await listSmartRecruitersJobs(id, company.name), supported: true };
    case "workday":
      if (!id) return { jobs: [], supported: false };
      return {
        jobs: await listWorkdayJobs(id, company.name, (title) => TARGET_KEYWORDS.test(title)),
        supported: true,
      };
    case "icims":
      if (!id || !company.careersUrl) return { jobs: [], supported: false };
      return {
        jobs: await listIcimsJobs(id, company.careersUrl, company.name),
        supported: true,
      };
    case "eightfold":
      if (!id) return { jobs: [], supported: false };
      return { jobs: await listEightfoldJobs(id, company.name), supported: true };
    case "phenom":
      if (!id) return { jobs: [], supported: false };
      return { jobs: await listPhenomJobs(id, company.name), supported: true };
    case "employer-page": {
      // The employer publishes its openings as ordinary links to real job
      // pages. The "identifier" is the page holding those links.
      const listUrl = id ?? company.careersUrl;
      if (!listUrl) return { jobs: [], supported: false };
      return { jobs: await listEmployerPageJobs(listUrl, company.name), supported: true };
    }
    case "spa": {
      // No vendor tenant exists for this path: the "identifier" IS the careers
      // page, and the postings come from data the page embeds (JSON-LD or a
      // framework state blob) rather than from an ATS API.
      const pageUrl = id ?? company.careersUrl;
      if (!pageUrl) return { jobs: [], supported: false };
      return { jobs: await listSpaEmbeddedJobs(pageUrl, company.name), supported: true };
    }
    case "successfactors":
      if (!company.careersUrl) return { jobs: [], supported: false };
      return {
        jobs: await listSuccessFactorsJobs(company.careersUrl, company.name),
        supported: true,
      };
    case "taleo":
    case "custom": {
      if (!company.careersUrl) return { jobs: [], supported: false };
      // Taleo and fully custom sites still use the low-confidence fallback and
      // remain quarantined until they get their own structured adapters.
      const result = await scanCareersPageForInternshipLinks(company.careersUrl, company.name, {
        etag: company.lastETag,
        lastModified: company.lastModified,
        contentHash: company.contentHash,
      });
      return {
        jobs: result.jobs,
        supported: true,
        notModified: result.notModified,
        etag: result.etag,
        lastModified: result.lastModified,
        contentHash: result.contentHash,
      };
    }
    default:
      return { jobs: [], supported: false };
  }
}
