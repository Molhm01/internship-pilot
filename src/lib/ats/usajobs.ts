import type { AtsJob } from "@/lib/ats/types";

// USAJOBS official Search API (data.usajobs.gov) — free registration required
// at https://developer.usajobs.gov. Credential-gated: without a key this
// adapter simply reports "not configured" rather than failing loudly.

export type UsaJobsConfig = { apiKey: string; userAgent: string };

export function getUsaJobsConfig(): UsaJobsConfig | null {
  const apiKey = process.env.USAJOBS_API_KEY;
  const userAgent = process.env.USAJOBS_USER_AGENT;
  if (!apiKey || !userAgent) return null;
  return { apiKey, userAgent };
}

type UsaJobsItem = {
  MatchedObjectId: string;
  MatchedObjectDescriptor: {
    PositionTitle: string;
    OrganizationName: string;
    PositionLocationDisplay?: string;
    PositionURI: string;
    QualificationSummary?: string;
    PositionStartDate?: string;
    UserArea?: { Details?: { JobSummary?: string } };
  };
};

export async function searchUsaJobs(keyword: string, config: UsaJobsConfig): Promise<AtsJob[]> {
  const url = `https://data.usajobs.gov/api/search?Keyword=${encodeURIComponent(keyword)}&ResultsPerPage=50`;
  let data: { SearchResult?: { SearchResultItems?: UsaJobsItem[] } };
  try {
    const res = await fetch(url, {
      headers: {
        Host: "data.usajobs.gov",
        "User-Agent": config.userAgent,
        "Authorization-Key": config.apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    data = await res.json();
  } catch {
    return [];
  }

  const items = data.SearchResult?.SearchResultItems ?? [];
  return items.map((item) => {
    const d = item.MatchedObjectDescriptor;
    return {
      sourceJobId: item.MatchedObjectId,
      requisitionId: null,
      title: d.PositionTitle,
      company: d.OrganizationName ? `${d.OrganizationName} (Federal)` : "U.S. Federal Government",
      location: d.PositionLocationDisplay ?? null,
      workplaceType: null,
      applyUrl: d.PositionURI,
      description: [d.UserArea?.Details?.JobSummary, d.QualificationSummary].filter(Boolean).join("\n\n"),
      postedAt: d.PositionStartDate ? new Date(d.PositionStartDate) : null,
    };
  });
}
