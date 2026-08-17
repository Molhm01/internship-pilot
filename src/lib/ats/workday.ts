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

// Best-effort: this ATS varies a lot per tenant, so we fetch a batch and do
// our own keyword filtering rather than trusting Workday search relevance.
export async function listWorkdayJobs(
  atsIdentifier: string,
  companyName: string,
  keywordFilter: (title: string) => boolean,
): Promise<AtsJob[]> {
  const { tenant, hostLabel, site } = parseAtsIdentifier(atsIdentifier);
  const host = `${hostLabel}.myworkdayjobs.com`;
  const base = `https://${host}/wday/cxs/${tenant}/${site}`;

  const list = (await postJson(`${base}/jobs`, {
    appliedFacets: {},
    limit: 100,
    offset: 0,
    searchText: "",
  })) as { jobPostings?: WorkdayPosting[]; total?: number } | null;

  if (!list?.jobPostings?.length) return [];

  const candidates = list.jobPostings.filter((p) => keywordFilter(p.title));
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
