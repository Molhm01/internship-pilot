import { fetchJsonRequired, type AtsJob } from "@/lib/ats/types";

/**
 * IBM's own public careers search.
 *
 * IBM serves careers.ibm.com as a client-rendered shell — the server HTML
 * carries no postings, `__NEXT_DATA__` is a 692-byte empty shell, and three
 * guessed endpoints all 404'd. Guessing further was the wrong move; observing
 * was the right one. Loading www.ibm.com/careers/search in an ordinary browser
 * and recording the fetch/XHR traffic IBM's OWN frontend makes shows a single
 * public, unauthenticated search endpoint behind the whole page.
 *
 * The request shape below is the one the page itself sends, verbatim, because
 * the endpoint validates it strictly: a `query_string` clause inside
 * `query.bool.must` is rejected outright as "Invalid value". The only change
 * is the one facet filter the site's own Internship tab applies, which narrows
 * 1,461 postings to 189 and makes this affordable in the five-minute lane —
 * two requests instead of fifteen.
 *
 * No bot protection, CAPTCHA, credential, or private endpoint is involved.
 *
 * IBM exposes no posting date on this endpoint, so `postedAt` is null and the
 * date is recorded as UNKNOWN rather than invented.
 */

const SEARCH_ENDPOINT = "https://www-api.ibm.com/search/api/v2";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * The facet fields, named from the site's own aggregation request:
 *   field_keyword_08  career area      ("Sales", "Software Engineering")
 *   field_keyword_17  workplace type   ("Hybrid", "Remote")
 *   field_keyword_18  experience level ("Internship", "Entry Level")
 *   field_keyword_19  location         ("Zurich, CH", "Multiple Cities")
 */
const FIELD_WORKPLACE = "field_keyword_17";
const FIELD_EXPERIENCE = "field_keyword_18";
const FIELD_LOCATION = "field_keyword_19";

const INTERNSHIP_FACET = "Internship";

const PAGE_SIZE = 100;
const MAX_PAGES = 4;

type IbmHit = {
  _id?: string;
  _source?: {
    title?: string;
    url?: string;
    description?: string;
    language?: string;
    [FIELD_WORKPLACE]?: string;
    [FIELD_EXPERIENCE]?: string;
    [FIELD_LOCATION]?: string;
  };
};

type IbmResponse = {
  hits?: { total?: { value?: number }; hits?: IbmHit[] };
};

function searchBody(from: number): string {
  return JSON.stringify({
    appId: "careers",
    scopes: ["careers2"],
    // Strictly validated by the endpoint — the internship facet is the only
    // clause it accepts here, and it is the clause the site's own tab sends.
    query: { bool: { must: [{ term: { [FIELD_EXPERIENCE]: INTERNSHIP_FACET } }] } },
    size: PAGE_SIZE,
    from,
    sort: [{ _score: "desc" }],
    lang: "zz",
    localeSelector: {},
    sm: { query: "", lang: "zz" },
    _source: ["_id", "title", "url", "description", "language", FIELD_WORKPLACE, FIELD_EXPERIENCE, FIELD_LOCATION],
  });
}

/** `…/JobDetail?jobId=129622` → "129622". The requisition IBM itself uses. */
export function ibmJobIdFrom(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("jobId");
  } catch {
    return null;
  }
}

function plainText(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    // Replacing a tag with a space leaves "…Intern ." wherever markup hugged
    // punctuation. Harmless to a reader, but the JD is what the ATS scorer
    // reads, so it should not be littered with artefacts of the strip.
    .replace(/\s+([.,;:!?)\]])/g, "$1")
    .replace(/([([])\s+/g, "$1")
    .trim();
}

/** Pure, so the response contract is pinned without a network call. */
export function parseIbmCareersJobs(payload: unknown, companyName: string): AtsJob[] {
  const response = payload as IbmResponse | null;
  const hits = response?.hits?.hits;
  if (!Array.isArray(hits)) return [];

  const jobs: AtsJob[] = [];
  for (const hit of hits) {
    const source = hit?._source;
    const url = source?.url?.trim();
    const title = source?.title?.trim();
    if (!url || !title) continue;
    // Only IBM's own posting pages are ever a canonical destination.
    if (!/^https:\/\/(?:[a-z0-9-]+\.)?ibm\.com\//i.test(url)) continue;

    const jobId = ibmJobIdFrom(url);
    const workplace = source?.[FIELD_WORKPLACE]?.trim() ?? null;

    jobs.push({
      sourceJobId: jobId ?? hit._id ?? url,
      requisitionId: jobId,
      title,
      company: companyName,
      location: source?.[FIELD_LOCATION]?.trim() || null,
      workplaceType: workplace && /remote|hybrid/i.test(workplace) ? workplace : null,
      applyUrl: url,
      description: plainText(source?.description),
      // The endpoint exposes no publication date. Left null so the ingest path
      // records UNKNOWN rather than treating discovery time as posting time.
      postedAt: null,
      postedAtText: null,
      employmentType: source?.[FIELD_EXPERIENCE]?.trim() ?? null,
    });
  }
  return jobs;
}

export async function listIbmCareersJobs(companyName: string): Promise<AtsJob[]> {
  const collected: AtsJob[] = [];
  const seen = new Set<string>();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await fetchJsonRequired(
      SEARCH_ENDPOINT,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        body: searchBody(page * PAGE_SIZE),
      },
      20_000,
    );

    const batch = parseIbmCareersJobs(payload, companyName);
    for (const job of batch) {
      if (seen.has(job.applyUrl)) continue;
      seen.add(job.applyUrl);
      collected.push(job);
    }

    const total = (payload as IbmResponse)?.hits?.total?.value ?? 0;
    if (batch.length === 0 || collected.length >= total) break;
  }

  return collected;
}
