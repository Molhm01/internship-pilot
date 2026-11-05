import type { AtsJob } from "@/lib/ats/types";
import { crawlStructuredPortalJobs } from "@/lib/ats/structuredCareer";

// iCIMS itself answers some automated clients with HTTP 405; the macOS Chrome
// agent string is the one observed to be served (see structuredCareer.ts).
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const SEARCH_TERMS = ["intern", "co-op"] as const;
const PAGE_SIZE = 100;
const PAGES_PER_TERM = 3;
const REQUEST_TIMEOUT_MS = 20_000;

export async function listIcimsJobs(
  atsIdentifier: string,
  careersUrl: string,
  companyName: string,
  options: { throwOnFetchError?: boolean } = {},
): Promise<AtsJob[]> {
  const startUrls = new Set<string>();
  if (atsIdentifier && /^[a-z0-9-]+$/i.test(atsIdentifier)) {
    startUrls.add(`https://${atsIdentifier}.icims.com/jobs/search?ss=1`);
  }

  return crawlStructuredPortalJobs({
    kind: "icims",
    companyName,
    careersUrl,
    additionalStartUrls: [...startUrls],
    maxListPages: 6,
    maxJobDetails: 35,
    throwOnFetchError: options.throwOnFetchError,
  });
}

type JibeRow = {
  data?: {
    slug?: string | number;
    req_id?: string | number;
    title?: string;
    full_location?: string;
    city?: string;
    state?: string;
    country?: string;
    category?: string[];
    apply_url?: string;
    description?: string;
    posted_date?: string;
  };
};

type JibeResponse = { jobs?: JibeRow[]; count?: number };

/**
 * Newer iCIMS career sites (the Jibe-built "careers-home" front ends, e.g.
 * careers.amd.com) client-render their job list: the HTML crawl above reads a
 * shell with zero postings. The front end itself is backed by an
 * unauthenticated JSON feed on the careers-site origin:
 *
 *   GET <origin>/api/jobs?keywords=<term>&page=<n>&limit=100
 *     -> { jobs: [{ data: { req_id, title, full_location, apply_url,
 *                           posted_date, description, category, ... } }],
 *          count: <total matching rows> }
 *
 * Verified live against careers.amd.com on 2026-11-05 (1259 open reqs, 103
 * matching "intern"). The feed is NOT served from the <tenant>.icims.com
 * subdomain, so it is keyed off the company's careersUrl origin.
 *
 * Returns null when the origin exposes no such feed, so the caller can mark
 * the board unsupported instead of reporting a false-success zero.
 */
export async function listIcimsJibeJobs(
  careersUrl: string,
  companyName: string,
  diag?: { note?: string },
): Promise<AtsJob[] | null> {
  let origin: string;
  try {
    origin = new URL(careersUrl).origin;
  } catch {
    if (diag) diag.note = "invalid careersUrl";
    return null;
  }

  const found = new Map<string, AtsJob>();
  let feedSeen = false;
  for (const term of SEARCH_TERMS) {
    for (let page = 1; page <= PAGES_PER_TERM; page++) {
      const url = `${origin}/api/jobs?keywords=${encodeURIComponent(
        term,
      )}&page=${page}&limit=${PAGE_SIZE}`;
      let data: JibeResponse | null = null;
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.ok) {
          data = (await res.json()) as JibeResponse;
        } else if (!feedSeen) {
          console.warn("[icims-jibe] feed request failed", { host: origin, status: res.status });
          if (diag) diag.note = `feed HTTP ${res.status} from ${origin}`;
        }
      } catch (err) {
        if (!feedSeen) {
          console.warn("[icims-jibe] feed request threw", {
            host: origin,
            error: err instanceof Error ? err.message : String(err),
          });
          if (diag) diag.note = `feed fetch threw: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      if (!data || !Array.isArray(data.jobs)) {
        // A 404/HTML shell on the very first request means this origin has no
        // Jibe feed at all; later failures just bound that term's pagination.
        if (!feedSeen) return null;
        break;
      }
      feedSeen = true;
      for (const row of data.jobs) {
        const job = mapJibeRow(row, companyName, origin);
        if (job && !found.has(job.sourceJobId)) found.set(job.sourceJobId, job);
      }
      const returned = data.jobs.length;
      const total = typeof data.count === "number" ? data.count : null;
      if (returned < PAGE_SIZE) break;
      if (total !== null && page * PAGE_SIZE >= total) break;
    }
  }
  return feedSeen ? [...found.values()] : null;
}

function mapJibeRow(row: JibeRow, companyName: string, origin: string): AtsJob | null {
  const d = row?.data;
  if (!d) return null;
  const slug = d.slug != null ? String(d.slug) : d.req_id != null ? String(d.req_id) : null;
  const title = (d.title ?? "").trim();
  if (!slug || !title) return null;
  const location =
    (d.full_location ?? "").trim() ||
    [d.city, d.state, d.country].filter(Boolean).join(", ") ||
    null;
  const postedAt = d.posted_date ? new Date(d.posted_date) : null;
  return {
    sourceJobId: slug,
    requisitionId: d.req_id != null ? String(d.req_id) : null,
    title,
    company: companyName,
    location,
    workplaceType: location && /remote/i.test(location) ? "Remote" : null,
    // The feed's apply_url lands on an iCIMS login wall
    // (campus-<tenant>.icims.com/jobs/<id>/login); the Jibe front end's own
    // job page is the public posting (verified careers.amd.com 200 + title).
    applyUrl: `${origin}/careers-home/jobs/${slug}`,
    description: d.description ?? "",
    postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : null,
    employmentType: (d.category ?? []).some((c) => /intern/i.test(c)) ? "Intern" : null,
  };
}
