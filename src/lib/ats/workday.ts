import type { AtsJob } from "@/lib/ats/types";

// Workday CXS ("Candidate Experience System") is the JSON backend every public
// Workday career site's own page calls to render its listings. `atsIdentifier`
// supports both the legacy `tenant/site` form and the shard-aware
// `tenant.wdN/site` form produced by ATS detection.

type WorkdayPosting = {
  title: string;
  externalPath: string;
  postedOn?: string;
  bulletFields?: string[];
};

type WorkdayDetail = {
  jobPostingInfo?: {
    jobDescription?: string;
    location?: string;
    additionalLocations?: string[];
    jobReqId?: string;
    externalUrl?: string;
    postedOn?: string;
  };
};

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
}

function parseAtsIdentifier(atsIdentifier: string): { tenant: string; hostLabel: string; site: string } {
  const [tenantOrHost, site] = atsIdentifier.split("/");
  const shardAware = tenantOrHost.match(/^([a-z0-9-]+)\.(wd\d+)$/i);
  if (shardAware) {
    return {
      tenant: shardAware[1],
      hostLabel: `${shardAware[1]}.${shardAware[2]}`,
      site: site || "External",
    };
  }
  return { tenant: tenantOrHost, hostLabel: `${tenantOrHost}.wd1`, site: site || "External" };
}

async function postJson(url: string, body: unknown, timeoutMs = 10_000): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function getJson(url: string, timeoutMs = 10_000): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Search terms sent to Workday itself.
 *
 * REGRESSION FIX: this used to request the first 100 postings with an empty
 * search and filter them locally. On a large tenant that is the first 100 of
 * several thousand in no useful order — Micron's board carries 2,718 postings
 * including "Intern - Yield Enhancement, Data Analysis", and the unfiltered
 * first page contained no internship at all, so the adapter returned zero and
 * the employer looked like it had nothing open. Letting Workday do the search
 * is what actually surfaces internships on big boards.
 */
const WORKDAY_SEARCH_TERMS = ["intern", "internship", "co-op"] as const;
const WORKDAY_PAGE_SIZE = 20;
const WORKDAY_PAGES_PER_TERM = 3;

// Best-effort: this ATS varies a lot per tenant, so vendor search is used to
// narrow the board and the caller's own keyword filter still has the final say.
export async function listWorkdayJobs(
  atsIdentifier: string,
  companyName: string,
  keywordFilter: (title: string) => boolean,
): Promise<AtsJob[]> {
  const { tenant, hostLabel, site } = parseAtsIdentifier(atsIdentifier);
  const host = `${hostLabel}.myworkdayjobs.com`;
  const base = `https://${host}/wday/cxs/${tenant}/${site}`;

  const postings = new Map<string, WorkdayPosting>();
  for (const searchText of WORKDAY_SEARCH_TERMS) {
    for (let page = 0; page < WORKDAY_PAGES_PER_TERM; page += 1) {
      const list = (await postJson(`${base}/jobs`, {
        appliedFacets: {},
        limit: WORKDAY_PAGE_SIZE,
        offset: page * WORKDAY_PAGE_SIZE,
        searchText,
      })) as { jobPostings?: WorkdayPosting[]; total?: number } | null;

      const batch = list?.jobPostings ?? [];
      for (const posting of batch) {
        if (posting.externalPath) postings.set(posting.externalPath, posting);
      }
      // Stop paging a term as soon as the tenant runs out of matches for it.
      if (batch.length < WORKDAY_PAGE_SIZE) break;
    }
  }

  if (postings.size === 0) return [];

  const candidates = [...postings.values()].filter((p) => keywordFilter(p.title));
  const jobs: AtsJob[] = [];

  for (const p of candidates.slice(0, 25)) {
    const detail = (await getJson(`${base}${p.externalPath}`)) as WorkdayDetail | null;
    const info = detail?.jobPostingInfo;
    jobs.push({
      sourceJobId: p.externalPath,
      requisitionId: info?.jobReqId ?? p.bulletFields?.[0] ?? null,
      title: p.title,
      company: companyName,
      location: info?.location ?? null,
      workplaceType: /remote/i.test(info?.location ?? "") ? "Remote" : null,
      applyUrl: info?.externalUrl ?? `https://${host}/${site}${p.externalPath}`,
      description: info?.jobDescription ? stripHtml(info.jobDescription) : "",
      postedAt: null,
      postedAtText: info?.postedOn ?? p.postedOn ?? null,
    });
  }
  return jobs;
}
