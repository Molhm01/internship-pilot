import type { AtsJob } from "@/lib/ats/types";

// Workday CXS is the JSON service used by public myworkdayjobs career sites.
// A board probe uses one unfiltered page to validate tenant/site and obtain the
// board total, then narrow vendor-side searches for internships. This avoids
// downloading thousands of unrelated requisitions from large tenants.

type WorkdayPosting = {
  title: string;
  externalPath: string;
  postedOn?: string;
  bulletFields?: string[];
};

type WorkdaySearch = { jobPostings?: WorkdayPosting[]; total?: number };

type WorkdayDetail = {
  jobPostingInfo?: {
    jobDescription?: string;
    location?: string;
    additionalLocations?: string[];
    jobReqId?: string;
    externalUrl?: string;
    postedOn?: string;
    startDate?: string;
  };
};

export type WorkdayConfiguration = {
  tenant: string;
  shard: string;
  hostLabel: string;
  site: string;
  host: string;
  baseUrl: string;
  derivedFromCareersUrl: boolean;
};

export type WorkdayProbe = {
  jobs: AtsJob[];
  totalAvailableJobs: number;
  internshipPostingsScanned: number;
  paginationVerified: boolean;
  configuration: WorkdayConfiguration;
};

const WORKDAY_SEARCH_TERMS = ["intern", "internship", "co-op"] as const;
const WORKDAY_PAGE_SIZE = 20;
const WORKDAY_PAGES_PER_TERM = 3;
const LOCALE_SEGMENT = /^[a-z]{2}(?:-[A-Z]{2})?$/i;

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
}

function fromCareersUrl(careersUrl: string | null | undefined): Partial<WorkdayConfiguration> | null {
  if (!careersUrl) return null;
  try {
    const url = new URL(careersUrl);
    const host = url.hostname.toLowerCase();
    const match = host.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
    if (!match) return null;
    const path = url.pathname.split("/").filter(Boolean);
    const site = path.find((segment) => !LOCALE_SEGMENT.test(segment));
    return { tenant: match[1], shard: match[2], hostLabel: `${match[1]}.${match[2]}`, site };
  } catch {
    return null;
  }
}

export function parseWorkdayConfiguration(
  atsIdentifier: string,
  careersUrl?: string | null,
): WorkdayConfiguration | null {
  const identifier = atsIdentifier.trim();
  const [tenantOrHost = "", rawSite = ""] = identifier.split("/");
  const shardAware = tenantOrHost.match(/^([a-z0-9-]+)\.(wd\d+)$/i);
  const fromUrl = fromCareersUrl(careersUrl);
  const tenant = fromUrl?.tenant ?? shardAware?.[1] ?? tenantOrHost;
  const shard = fromUrl?.shard ?? shardAware?.[2] ?? "wd1";
  const site = fromUrl?.site ?? rawSite;
  if (!/^[a-z0-9-]+$/i.test(tenant) || !/^wd\d+$/i.test(shard) || !site || LOCALE_SEGMENT.test(site)) {
    return null;
  }
  const hostLabel = `${tenant}.${shard}`;
  const host = `${hostLabel}.myworkdayjobs.com`;
  return {
    tenant,
    shard,
    hostLabel,
    site,
    host,
    baseUrl: `https://${host}/wday/cxs/${tenant}/${site}`,
    derivedFromCareersUrl: Boolean(fromUrl),
  };
}

async function postJson(url: string, body: unknown, timeoutMs = 10_000): Promise<unknown> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Workday returned HTTP ${response.status}.`), {
        code: `ATS_HTTP_${response.status}`,
      });
    }
    const value = await response.json();
    if (!value || typeof value !== "object" || !("jobPostings" in value)) {
      throw Object.assign(new Error("Workday response did not contain a jobs collection."), {
        code: "ATS_SCHEMA_INVALID",
      });
    }
    return value;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const code = error instanceof Error && /timeout|abort/i.test(error.message) ? "ATS_TIMEOUT" : "ATS_NETWORK";
    throw Object.assign(new Error("Workday search request failed."), { code, cause: error });
  }
}

async function getDetail(url: string, timeoutMs = 10_000): Promise<WorkdayDetail | null> {
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return await response.json() as WorkdayDetail;
  } catch {
    return null;
  }
}

function searchBody(searchText: string, offset: number) {
  return { appliedFacets: {}, limit: WORKDAY_PAGE_SIZE, offset, searchText };
}

export async function probeWorkdayJobs(
  atsIdentifier: string,
  careersUrl: string | null | undefined,
  companyName: string,
  keywordFilter: (title: string) => boolean,
): Promise<WorkdayProbe> {
  const configuration = parseWorkdayConfiguration(atsIdentifier, careersUrl);
  if (!configuration) {
    throw Object.assign(new Error("Workday tenant/site configuration is malformed."), { code: "ATS_CONFIG_MALFORMED" });
  }

  const first = await postJson(`${configuration.baseUrl}/jobs`, searchBody("", 0)) as WorkdaySearch;
  const totalAvailableJobs = Math.max(0, Number(first.total ?? first.jobPostings?.length ?? 0));
  let paginationVerified = totalAvailableJobs <= WORKDAY_PAGE_SIZE;
  if (totalAvailableJobs > WORKDAY_PAGE_SIZE) {
    const second = await postJson(
      `${configuration.baseUrl}/jobs`,
      searchBody("", WORKDAY_PAGE_SIZE),
    ) as WorkdaySearch;
    paginationVerified = Array.isArray(second.jobPostings);
  }

  const postings = new Map<string, WorkdayPosting>();
  for (const searchText of WORKDAY_SEARCH_TERMS) {
    for (let page = 0; page < WORKDAY_PAGES_PER_TERM; page += 1) {
      const list = await postJson(
        `${configuration.baseUrl}/jobs`,
        searchBody(searchText, page * WORKDAY_PAGE_SIZE),
      ) as WorkdaySearch;
      const batch = list.jobPostings ?? [];
      for (const posting of batch) {
        if (posting.externalPath) postings.set(posting.externalPath, posting);
      }
      if (batch.length < WORKDAY_PAGE_SIZE) break;
    }
  }

  const candidates = [...postings.values()].filter((posting) => keywordFilter(posting.title));
  const jobs: AtsJob[] = [];
  for (const posting of candidates.slice(0, 40)) {
    const detail = await getDetail(`${configuration.baseUrl}${posting.externalPath}`);
    const info = detail?.jobPostingInfo;
    jobs.push({
      sourceJobId: posting.externalPath,
      requisitionId: info?.jobReqId ?? posting.bulletFields?.[0] ?? null,
      title: posting.title,
      company: companyName,
      location: info?.location ?? null,
      workplaceType: /remote/i.test(info?.location ?? "") ? "Remote" : null,
      applyUrl: info?.externalUrl ?? `https://${configuration.host}/${configuration.site}${posting.externalPath}`,
      description: info?.jobDescription ? stripHtml(info.jobDescription) : "",
      // startDate is an authoritative calendar date when present. Workday's
      // postedOn wording is retained as relative/date-only evidence otherwise.
      postedAt: info?.startDate ? new Date(info.startDate) : null,
      postedAtText: info?.postedOn ?? posting.postedOn ?? null,
    });
    // Detail hydration is intentionally serial with a small cooldown. The
    // board search is cheap; dozens of detail reads should not become a burst.
    await new Promise((resolve) => setTimeout(resolve, 75));
  }

  return {
    jobs,
    totalAvailableJobs,
    internshipPostingsScanned: postings.size,
    paginationVerified,
    configuration,
  };
}

export async function listWorkdayJobs(
  atsIdentifier: string,
  companyName: string,
  keywordFilter: (title: string) => boolean,
  careersUrl?: string | null,
): Promise<AtsJob[]> {
  return (await probeWorkdayJobs(atsIdentifier, careersUrl, companyName, keywordFilter)).jobs;
}
