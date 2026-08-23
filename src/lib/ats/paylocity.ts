import type { AtsJob } from "@/lib/ats/types";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TARGET_ROLE = /\b(?:intern(?:ship)?s?|co-?ops?|students?|apprentices?)\b/i;

export type PaylocityTenant = { companyId: string; slug: string };

export function parsePaylocityIdentifier(identifier: string): PaylocityTenant | null {
  const [companyId, slug] = identifier.split("|");
  if (!companyId || !slug) return null;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)
    || !/^[a-z0-9_-]+$/i.test(slug)
  ) return null;
  return { companyId: companyId.toLowerCase(), slug };
}

type PaylocityRow = {
  JobId?: number | string;
  JobTitle?: string;
  LocationName?: string;
  PublishedDate?: string;
  Description?: string;
  IsRemote?: boolean;
};

type PaylocityPageData = { Jobs?: PaylocityRow[] };

function embeddedPageData(html: string): unknown | null {
  const marker = /window\.pageData\s*=\s*/i.exec(html);
  if (!marker) return null;
  const start = marker.index + marker[0].length;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, index + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Pure parser for the board's public window.pageData contract. */
export function parsePaylocityJobs(
  html: string,
  companyName: string,
): AtsJob[] {
  const rows = (embeddedPageData(html) as PaylocityPageData | null)?.Jobs;
  if (!Array.isArray(rows)) return [];
  const jobs: AtsJob[] = [];
  for (const row of rows) {
    const id = row.JobId === undefined || row.JobId === null ? "" : String(row.JobId).trim();
    const title = row.JobTitle?.trim() ?? "";
    if (!id || !title || !TARGET_ROLE.test(title)) continue;
    const postedAt = row.PublishedDate ? new Date(row.PublishedDate) : null;
    jobs.push({
      sourceJobId: id,
      requisitionId: id,
      title,
      company: companyName,
      location: row.LocationName?.trim() || null,
      workplaceType: row.IsRemote ? "Remote" : null,
      applyUrl: `https://recruiting.paylocity.com/Recruiting/Jobs/Details/${encodeURIComponent(id)}`,
      description: row.Description?.trim() ?? "",
      postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : null,
      postedAtText: row.PublishedDate?.trim() || null,
    });
  }
  return jobs;
}

export async function listPaylocityJobs(
  identifier: string,
  companyName: string,
): Promise<AtsJob[]> {
  const tenant = parsePaylocityIdentifier(identifier);
  if (!tenant) return [];
  const url =
    `https://recruiting.paylocity.com/recruiting/jobs/All/` +
    `${tenant.companyId}/${encodeURIComponent(tenant.slug)}`;
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Paylocity returned HTTP ${response.status}.`), {
      code: `ATS_HTTP_${response.status}`,
    });
  }
  return parsePaylocityJobs(await response.text(), companyName);
}
