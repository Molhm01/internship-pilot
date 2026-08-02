import type { AtsJob } from "@/lib/ats/types";

// Workday CXS ("Candidate Experience System") is the JSON backend every public
// Workday career site's own page calls to render its listings — verified
// live against micron.wd1.myworkdayjobs.com during development. There's no
// official public API doc, but the endpoint shape is stable and widely relied
// on; we only ever call the same read-only listing/detail endpoints the
// public career page itself uses. `atsIdentifier` is stored as "tenant/site"
// (site defaults to "External", the most common Workday site name).

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

function parseAtsIdentifier(atsIdentifier: string): { tenant: string; site: string } {
  const [tenant, site] = atsIdentifier.split("/");
  return { tenant, site: site || "External" };
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

// Best-effort: this ATS varies a lot per-tenant (subdomain shard, site name),
// and Workday's own search relevance is unreliable, so we fetch a batch and
// do our own keyword filtering rather than trusting `searchText`.
export async function listWorkdayJobs(
  atsIdentifier: string,
  companyName: string,
  keywordFilter: (title: string) => boolean,
): Promise<AtsJob[]> {
  const { tenant, site } = parseAtsIdentifier(atsIdentifier);
  const base = `https://${tenant}.wd1.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;

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
      applyUrl: info?.externalUrl ?? `https://${tenant}.wd1.myworkdayjobs.com/${site}${p.externalPath}`,
      description: info?.jobDescription ? stripHtml(info.jobDescription) : "",
      // Workday exposes relative text ("Posted Today", "Posted 30+ Days Ago")
      // rather than a timestamp. The text is carried through verbatim and
      // resolved against the sync's capture time at ingest, so these postings
      // get a real (if lower-confidence) position in the freshness order
      // instead of dropping to the unknown-date tail.
      postedAt: null,
      postedAtText: info?.postedOn ?? p.postedOn ?? null,
    });
  }
  return jobs;
}
