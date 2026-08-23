import { fetchJsonRequired, type AtsJob } from "@/lib/ats/types";

/**
 * Oracle Recruiting Cloud's public Candidate Experience search.
 *
 * The request contract was observed from the public employer frontend. It is
 * unauthenticated and returns requisition ids, titles, locations and posting
 * dates. The identifier carries every employer-published routing value:
 * `<oracleHost>|<locale>|<siteNumber>`.
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const TARGET_ROLE = /\b(?:intern(?:ship)?s?|co-?ops?|students?|apprentices?)\b/i;

export type OracleRecruitingCloudTenant = {
  host: string;
  locale: string;
  siteNumber: string;
};

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/** Employer brand stated by the public Candidate Experience page. */
export function oracleRecruitingCloudBoardName(html: string): string | null {
  const meta = html.match(
    /<meta\b[^>]*(?:property|name)=["'](?:og:site_name|og:title)["'][^>]*content=["']([^"']+)["'][^>]*>/i,
  )?.[1];
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const value = decodeHtml(meta ?? title ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value || null;
}

export function parseOracleRecruitingCloudIdentifier(
  identifier: string,
): OracleRecruitingCloudTenant | null {
  const [host, locale, siteNumber] = identifier.split("|");
  if (!host || !locale || !siteNumber) return null;
  if (!/^[a-z0-9.-]+$/i.test(host) || !/^[a-z]{2}(?:-[A-Z]{2})?$/i.test(locale)) return null;
  if (!/^[a-z0-9_-]+$/i.test(siteNumber)) return null;
  return { host: host.toLowerCase(), locale, siteNumber };
}

type OracleRequisition = {
  Id?: string | number;
  Title?: string;
  PostedDate?: string;
  PrimaryLocation?: string;
  WorkplaceType?: string;
  ShortDescriptionStr?: string;
  ExternalQualificationsStr?: string | null;
  ExternalResponsibilitiesStr?: string | null;
};

type OracleSearchItem = {
  TotalJobsCount?: number;
  requisitionList?: OracleRequisition[];
};

type OracleSearchResponse = { items?: OracleSearchItem[] };

function descriptionOf(row: OracleRequisition): string {
  return [row.ShortDescriptionStr, row.ExternalResponsibilitiesStr, row.ExternalQualificationsStr]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

/** Pure response mapper, pinned by fixtures. */
export function parseOracleRecruitingCloudJobs(
  payload: unknown,
  tenant: OracleRecruitingCloudTenant,
  companyName: string,
): AtsJob[] {
  const item = (payload as OracleSearchResponse | null)?.items?.[0];
  if (!Array.isArray(item?.requisitionList)) return [];
  const jobs: AtsJob[] = [];
  for (const row of item.requisitionList) {
    const id = row.Id === undefined || row.Id === null ? "" : String(row.Id).trim();
    const title = row.Title?.trim() ?? "";
    if (!id || !title || !TARGET_ROLE.test(title)) continue;
    const postedAt = row.PostedDate ? new Date(`${row.PostedDate}T00:00:00Z`) : null;
    jobs.push({
      sourceJobId: id,
      requisitionId: id,
      title,
      company: companyName,
      location: row.PrimaryLocation?.trim() || null,
      workplaceType: row.WorkplaceType?.trim() || null,
      applyUrl:
        `https://${tenant.host}/hcmUI/CandidateExperience/` +
        `${encodeURIComponent(tenant.locale)}/sites/${encodeURIComponent(tenant.siteNumber)}/job/${encodeURIComponent(id)}`,
      description: descriptionOf(row),
      postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : null,
      postedAtText: row.PostedDate?.trim() || null,
    });
  }
  return jobs;
}

export async function listOracleRecruitingCloudJobs(
  identifier: string,
  companyName: string,
): Promise<AtsJob[]> {
  const tenant = parseOracleRecruitingCloudIdentifier(identifier);
  if (!tenant) return [];
  const jobs = new Map<string, AtsJob>();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const finder = [
      `findReqs;siteNumber=${tenant.siteNumber}`,
      "facetsList=LOCATIONS;WORK_LOCATIONS;WORKPLACE_TYPES;TITLES;CATEGORIES;ORGANIZATIONS;POSTING_DATES;FLEX_FIELDS",
      `limit=${PAGE_SIZE}`,
      `offset=${page * PAGE_SIZE}`,
      "sortBy=POSTING_DATES_DESC",
    ].join(",");
    const url = new URL(
      `https://${tenant.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`,
    );
    url.searchParams.set("onlyData", "true");
    url.searchParams.set(
      "expand",
      "requisitionList.workLocation,requisitionList.otherWorkLocations,requisitionList.secondaryLocations,flexFieldsFacet.values,requisitionList.requisitionFlexFields",
    );
    url.searchParams.set("finder", finder);

    const payload = await fetchJsonRequired(
      url.toString(),
      {
        headers: {
          accept: "application/json",
          "ora-irc-language": tenant.locale,
          referer:
            `https://${tenant.host}/hcmUI/CandidateExperience/` +
            `${tenant.locale}/sites/${tenant.siteNumber}/jobs`,
          "User-Agent": USER_AGENT,
        },
      },
      20_000,
    );
    for (const job of parseOracleRecruitingCloudJobs(payload, tenant, companyName)) {
      jobs.set(job.sourceJobId, job);
    }
    const item = (payload as OracleSearchResponse)?.items?.[0];
    const returned = item?.requisitionList?.length ?? 0;
    const total = item?.TotalJobsCount ?? 0;
    if (returned < PAGE_SIZE || (total > 0 && (page + 1) * PAGE_SIZE >= total)) break;
  }
  return [...jobs.values()];
}
