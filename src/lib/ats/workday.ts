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
    description?: string;
    jobDescriptionText?: string;
    location?: string;
    additionalLocations?: string[];
    jobReqId?: string;
    externalUrl?: string;
    postedOn?: string;
    datePosted?: string | number;
    postedDate?: string | number;
    postingDate?: string | number;
    startDate?: string;
  };
};

export type WorkdayJobDetail = {
  description: string;
  location: string | null;
  requisitionId: string | null;
  applyUrl: string | null;
  /** Explicit posting evidence only. `startDate` is deliberately excluded. */
  postedAt: Date | null;
  postedAtText: string | null;
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

function normalizedWorkdayDetail(detail: WorkdayDetail | null): WorkdayJobDetail {
  const info = detail?.jobPostingInfo;
  const description = info?.jobDescription ?? info?.description ?? info?.jobDescriptionText ?? "";
  const explicitPostingValue = info?.datePosted ?? info?.postedDate ?? info?.postingDate ?? info?.postedOn;
  return {
    description: description ? stripHtml(description) : "",
    location: info?.location ?? null,
    requisitionId: info?.jobReqId ?? null,
    applyUrl: info?.externalUrl ?? null,
    postedAt: null,
    postedAtText: explicitPostingValue === undefined || explicitPostingValue === null
      ? null
      : String(explicitPostingValue),
  };
}

/**
 * Workday's own `externalPath` (`/job/{location}/{slug}_{requisitionId}`) out
 * of a public job/apply URL, given the site segment from the tenant config.
 *
 * A job discovered directly through `probeWorkdayJobs` stores this path as
 * `sourceJobId` (see below). A job discovered via a third-party aggregator
 * (Simplify/Zapply/ApplyGuy/Dreamwork, ...) has THAT service's id in
 * `sourceJobId` instead — a different identifier scheme, not a broken Workday
 * path — so it is derived from the URL, which always carries Workday's own
 * path regardless of how the job was discovered.
 */
export function workdayExternalPathFromUrl(url: string, site: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const prefix = `/${site}/`;
    // Workday sometimes inserts a locale segment before the site
    // (`/zh-CN/{site}/job/...`, `/en-US/{site}/job/...`) — measured on
    // Blackstone. Find the site segment wherever it starts, not only at the
    // very front of the path, so a locale prefix does not hide the job path.
    const index = pathname.indexOf(prefix);
    if (index < 0) return null;
    const rest = pathname.slice(index + prefix.length - 1);
    return rest === "/" ? null : rest;
  } catch {
    return null;
  }
}

/** Fetch one public CXS detail record without interpreting job start dates. */
export async function fetchWorkdayJobDetail(
  atsIdentifier: string,
  careersUrl: string | null | undefined,
  externalPath: string,
): Promise<WorkdayJobDetail | null> {
  const configuration = parseWorkdayConfiguration(atsIdentifier, careersUrl);
  if (!configuration) return null;
  const path = externalPath.startsWith("/")
    ? externalPath
    : (careersUrl && workdayExternalPathFromUrl(careersUrl, configuration.site)) || null;
  if (!path) return null;
  const detail = await getDetail(`${configuration.baseUrl}${path}`);
  return detail ? normalizedWorkdayDetail(detail) : null;
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
    const normalized = normalizedWorkdayDetail(detail);
    jobs.push({
      sourceJobId: posting.externalPath,
      requisitionId: normalized.requisitionId ?? posting.bulletFields?.[0] ?? null,
      title: posting.title,
      company: companyName,
      location: normalized.location,
      workplaceType: /remote/i.test(normalized.location ?? "") ? "Remote" : null,
      applyUrl: normalized.applyUrl ?? `https://${configuration.host}/${configuration.site}${posting.externalPath}`,
      description: normalized.description,
      // `startDate` is when employment begins, not when the employer posted
      // the requisition. Only explicit posting fields are allowed here.
      postedAt: normalized.postedAt,
      postedAtText: normalized.postedAtText ?? posting.postedOn ?? null,
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
