// Phenom People career sites.
//
// Like Eightfold, a Phenom careers page is a client-rendered shell — the HTML
// contains no postings, so employers on this vendor read as "no ATS config".
//
// Every Phenom site talks to one POST endpoint on the employer's own host,
// discriminated by a `ddoKey`. Observed live on 2026-08-22:
//
//   POST https://<careersHost>/widgets
//        { ddoKey: "refineSearch", keywords, from, size, ... , refNum }
//     -> { refineSearch: { status, totalHits, data: { jobs: [...] } } }
//
//   POST https://<careersHost>/widgets
//        { ddoKey: "jobDetail", jobSeqNo, jobId, refNum }
//     -> { jobDetail: { data: { job: { description, applyUrl, ... } } } }
//
// The tenant key is `refNum` (for example "PGBPGNGLOBAL"), which the page
// publishes both as a JSON field and inside its CDN asset paths.
//
// What makes this vendor especially valuable: each row carries `applyUrl`,
// which is the EMPLOYER'S OWN ATS destination (P&G's rows point straight at
// pg.wd5.myworkdayjobs.com). Phenom is a career-site layer over a real ATS, so
// resolving through it yields the true official application URL rather than a
// vendor microsite link.
//
// `atsIdentifier` is stored as "<careersHost>|<refNum>".

import type { AtsJob } from "@/lib/ats/types";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SEARCH_TERMS = ["intern", "co-op"] as const;
const PAGE_SIZE = 25;
const PAGES_PER_TERM = 2;
const REQUEST_TIMEOUT_MS = 20_000;

export type PhenomTenant = { careersHost: string; refNum: string };

export function parsePhenomIdentifier(atsIdentifier: string): PhenomTenant | null {
  const [careersHost, refNum] = atsIdentifier.split("|");
  if (!careersHost || !refNum) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(careersHost)) return null;
  return { careersHost: careersHost.toLowerCase(), refNum };
}

type PhenomJob = {
  jobId?: string;
  reqId?: string;
  jobSeqNo?: string;
  title?: string;
  location?: string;
  cityStateCountry?: string;
  cityState?: string;
  applyUrl?: string;
  externalApply?: boolean;
  postedDate?: string;
  dateCreated?: string;
  type?: string;
  description?: string;
  descriptionTeaser?: string;
  visibilityType?: string;
};

async function postWidget(
  tenant: PhenomTenant,
  body: Record<string, unknown>,
): Promise<unknown | null> {
  try {
    const response = await fetch(`https://${tenant.careersHost}/widgets`, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        Accept: "application/json",
        Referer: `https://${tenant.careersHost}/`,
      },
      body: JSON.stringify({
        lang: "en_global",
        deviceType: "desktop",
        country: "global",
        siteType: "external",
        refNum: tenant.refNum,
        ...body,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function jobsOf(payload: unknown): PhenomJob[] {
  const search = (payload as { refineSearch?: { data?: { jobs?: unknown } } } | null)?.refineSearch;
  return Array.isArray(search?.data?.jobs) ? (search.data.jobs as PhenomJob[]) : [];
}

function parseIsoDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function workplaceTypeOf(job: PhenomJob): string | null {
  const location = job.location ?? job.cityStateCountry ?? "";
  if (/remote/i.test(location)) return "Remote";
  if (/hybrid/i.test(location)) return "Hybrid";
  return null;
}

/**
 * The destination to send an applicant to.
 *
 * `applyUrl` is preferred because it is the employer's own ATS page. The Phenom
 * job page is only used when the row does not carry one — never an invented URL.
 */
export function phenomDestination(tenant: PhenomTenant, job: PhenomJob): string | null {
  const applyUrl = typeof job.applyUrl === "string" ? job.applyUrl.trim() : "";
  if (applyUrl && /^https:\/\//i.test(applyUrl)) return applyUrl;
  if (job.jobSeqNo) {
    return `https://${tenant.careersHost}/global/en/job/${encodeURIComponent(job.jobSeqNo)}`;
  }
  return null;
}

function toAtsJob(tenant: PhenomTenant, job: PhenomJob, companyName: string): AtsJob | null {
  const title = typeof job.title === "string" ? job.title.trim() : "";
  const destination = phenomDestination(tenant, job);
  if (!title || !destination) return null;

  const id = job.jobSeqNo ?? job.jobId ?? job.reqId;
  if (!id) return null;

  return {
    sourceJobId: String(id),
    requisitionId: job.reqId ?? job.jobId ?? null,
    title,
    company: companyName,
    location: job.cityStateCountry ?? job.location ?? job.cityState ?? null,
    workplaceType: workplaceTypeOf(job),
    applyUrl: destination,
    // refineSearch only carries a teaser. A teaser is a summary, not the
    // employer's job description, so it is deliberately NOT written here —
    // fetchPhenomJobDescription supplies the real one on demand.
    description: "",
    postedAt: parseIsoDate(job.postedDate) ?? parseIsoDate(job.dateCreated),
    postedAtText: null,
    employmentType: typeof job.type === "string" ? job.type : null,
  };
}

export async function listPhenomJobs(
  atsIdentifier: string,
  companyName: string,
): Promise<AtsJob[]> {
  const tenant = parsePhenomIdentifier(atsIdentifier);
  if (!tenant) return [];

  const byId = new Map<string, AtsJob>();
  for (const keywords of SEARCH_TERMS) {
    for (let page = 0; page < PAGES_PER_TERM; page += 1) {
      const payload = await postWidget(tenant, {
        pageName: "search-results",
        ddoKey: "refineSearch",
        sortBy: "",
        subsearch: "",
        from: page * PAGE_SIZE,
        jobs: true,
        counts: true,
        all_fields: ["category", "country", "state", "city", "type"],
        size: PAGE_SIZE,
        clicks: 0,
        keywords,
        global: true,
        selected_fields: {},
        locationData: {},
      });

      const jobs = jobsOf(payload);
      for (const job of jobs) {
        const converted = toAtsJob(tenant, job, companyName);
        if (converted) byId.set(converted.sourceJobId, converted);
      }
      if (jobs.length < PAGE_SIZE) break;
    }
  }
  return [...byId.values()];
}

/** Fetch the employer's real job description for one Phenom posting. */
export async function fetchPhenomJobDescription(
  atsIdentifier: string,
  jobSeqNo: string,
): Promise<string | null> {
  const tenant = parsePhenomIdentifier(atsIdentifier);
  if (!tenant) return null;
  const payload = (await postWidget(tenant, {
    pageName: "job-details",
    ddoKey: "jobDetail",
    jobSeqNo,
  })) as { jobDetail?: { data?: { job?: PhenomJob } } } | null;

  const description = payload?.jobDetail?.data?.job?.description;
  return typeof description === "string" && description.trim() ? description : null;
}
