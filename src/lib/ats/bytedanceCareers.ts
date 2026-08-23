import { fetchJsonRequired, type AtsJob } from "@/lib/ats/types";

/**
 * The ByteDance-family public careers search (TikTok, ByteDance, and siblings).
 *
 * These sites are fully client-rendered, so nothing useful is in their HTML.
 * The endpoint below was not guessed: it was observed by loading the
 * employer's own search page in an ordinary browser and recording the fetch
 * traffic its own frontend produced. The endpoint is literally namespaced
 * `/api/v1/public/…`, takes no credential, and the only non-standard header
 * the page sends is `website-path`, which selects the brand — routing
 * metadata, not authentication. No CAPTCHA or bot protection is involved.
 *
 * It is a genuine platform rather than one employer: the same request shape,
 * the same response shape and the same `search/{id}` canonical URL serve both
 *   TikTok     api.lifeattiktok.com  website-path: tiktok  lifeattiktok.com
 *   ByteDance  jobs.bytedance.com    website-path: en      joinbytedance.com
 *
 * The payload exposes no publication date, so `postedAt` stays null and the
 * row is recorded as UNKNOWN rather than dated from discovery time.
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const PAGE_SIZE = 50;
const MAX_PAGES = 4;

type LocationNode = { en_name?: string | null; parent?: LocationNode | null };

type ByteDancePost = {
  id?: string;
  code?: string;
  title?: string;
  description?: string;
  requirement?: string;
  recruit_type?: { en_name?: string | null } | null;
  city_info?: LocationNode | null;
};

type ByteDanceResponse = {
  code?: number;
  data?: { count?: number; job_post_list?: ByteDancePost[] };
};

/**
 * How one brand on this platform is addressed.
 *
 * Stored as "<apiHost>|<websitePath>|<siteHost>" so a new brand is a
 * configuration value discovered from its own site, never a code change.
 */
export type ByteDanceTenant = { apiHost: string; websitePath: string; siteHost: string };

export function parseByteDanceTenant(identifier: string): ByteDanceTenant | null {
  const [apiHost, websitePath, siteHost] = identifier.split("|");
  if (!apiHost || !websitePath || !siteHost) return null;
  if (!/^[a-z0-9.-]+$/i.test(apiHost) || !/^[a-z0-9.-]+$/i.test(siteHost)) return null;
  return { apiHost, websitePath, siteHost };
}

/** "San Jose, California, United States" from the nested city → state → country. */
export function flattenLocation(node: LocationNode | null | undefined): string | null {
  const parts: string[] = [];
  let current: LocationNode | null | undefined = node;
  let depth = 0;
  while (current && depth < 4) {
    const name = current.en_name?.trim();
    if (name && !parts.includes(name)) parts.push(name);
    current = current.parent;
    depth += 1;
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

function joinDescription(post: ByteDancePost): string {
  return [post.description, post.requirement]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n")
    .trim();
}

/** Pure, so the platform contract is pinned without a network call. */
export function parseByteDanceJobs(
  payload: unknown,
  tenant: ByteDanceTenant,
  companyName: string,
): AtsJob[] {
  const response = payload as ByteDanceResponse | null;
  const posts = response?.data?.job_post_list;
  if (!Array.isArray(posts)) return [];

  const jobs: AtsJob[] = [];
  for (const post of posts) {
    const id = post.id?.trim();
    const title = post.title?.trim();
    if (!id || !title) continue;

    jobs.push({
      sourceJobId: id,
      requisitionId: post.code?.trim() || null,
      title,
      company: companyName,
      location: flattenLocation(post.city_info),
      workplaceType: null,
      // The employer's own posting page, taken from the links its search page
      // renders — never an aggregator.
      applyUrl: `https://${tenant.siteHost}/search/${id}`,
      description: joinDescription(post),
      postedAt: null,
      postedAtText: null,
      employmentType: post.recruit_type?.en_name?.trim() ?? null,
    });
  }
  return jobs;
}

export async function listByteDanceJobs(
  identifier: string,
  companyName: string,
  keyword = "intern",
): Promise<AtsJob[]> {
  const tenant = parseByteDanceTenant(identifier);
  if (!tenant) return [];

  const collected: AtsJob[] = [];
  const seen = new Set<string>();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await fetchJsonRequired(
      `https://${tenant.apiHost}/api/v1/public/supplier/search/job/posts`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "*/*",
          // Brand routing, exactly as the employer's own page sends it.
          "website-path": tenant.websitePath,
          origin: `https://${tenant.siteHost}`,
          referer: `https://${tenant.siteHost}/`,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          keyword,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
          recruitment_id_list: [],
          job_category_id_list: [],
          subject_id_list: [],
          location_code_list: [],
        }),
      },
      20_000,
    );

    const batch = parseByteDanceJobs(payload, tenant, companyName);
    for (const job of batch) {
      if (seen.has(job.applyUrl)) continue;
      seen.add(job.applyUrl);
      collected.push(job);
    }

    const total = (payload as ByteDanceResponse)?.data?.count ?? 0;
    if (batch.length === 0 || collected.length >= total) break;
  }

  return collected;
}
