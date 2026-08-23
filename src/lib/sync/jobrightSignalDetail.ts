// Enrichment for one Jobright discovery signal.
//
// The Jobright category minisite that feeds the fresh radar exposes exactly one
// URL per row — `applyUrl` — and it is always a jobright.ai link. There is no
// employer destination in that payload at all, which is why a purely
// list-driven pipeline can resolve zero of forty-seven fresh signals.
//
// The per-job detail page carries the missing piece: the company's OWN website,
// published by the source as `companyResult.companyURL`. That domain is what
// lets the resolver go and find the employer's real careers page and ATS board
// instead of giving up because the employer is not already in the approved-
// employer CSV. It is read from the source, never guessed — the safety rule
// here is "do not invent company URLs", not "do not use one the source states".
//
// The detail page's `publishTime` string is deliberately IGNORED: it is written
// in an unspecified local zone (observed seven hours ahead of the same row's
// epoch `postedDate`), so trusting it would move real posting times. The list
// payload's epoch is the authoritative timestamp, and the relative
// `publishTimeDesc` is kept only as human wording for rows with no epoch.

import {
  extractOriginalJobPost,
  isAggregatorUrl,
  isValidOfficialApplicationUrl,
} from "@/lib/applications/officialDestination";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export type JobrightSignalDetail = {
  /** Hostname the source published as the employer's own website, if any. */
  companyDomain: string | null;
  /** The employer destination, when the source states one outright. */
  originalJobPostUrl: string | null;
  /** The source's relative wording ("2 hours ago"), when present. */
  postedText: string | null;
  /** True only when the source explicitly marks the posting as removed. */
  removedAtSource: boolean;
};

export const EMPTY_SIGNAL_DETAIL: JobrightSignalDetail = {
  companyDomain: null,
  originalJobPostUrl: null,
  postedText: null,
  removedAtSource: false,
};

// Hosts that are never an employer's own site, so never a resolution starting
// point. A social/aggregator profile URL in `companyURL` is not a careers site.
const NON_EMPLOYER_DOMAINS = [
  "jobright.ai",
  "linkedin.com",
  "crunchbase.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "youtube.com",
  "github.com",
  "wikipedia.org",
  "indeed.com",
  "glassdoor.com",
  "simplify.jobs",
  "intern-list.com",
] as const;

/**
 * Reduce a source-published company website to a bare hostname we are willing
 * to crawl. Returns null for anything that is not an employer's own site.
 */
export function employerDomainFrom(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!host.includes(".")) return null;
    if (host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    if (NON_EMPLOYER_DOMAINS.some((bad) => host === bad || host.endsWith(`.${bad}`))) return null;
    return host;
  } catch {
    return null;
  }
}

function nextDataOf(html: string): unknown | null {
  const marker = "__NEXT_DATA__";
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const start = html.indexOf(">", idx) + 1;
  const end = html.indexOf("</script>", start);
  if (start <= 0 || end === -1) return null;
  try {
    return JSON.parse(html.slice(start, end)) as unknown;
  } catch {
    return null;
  }
}

function readString(node: unknown, path: string[]): string | null {
  let cursor: unknown = node;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" && cursor.trim() ? cursor.trim() : null;
}

function readBoolean(node: unknown, path: string[]): boolean {
  let cursor: unknown = node;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") return false;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor === true;
}

/** Pure parser, so tests can feed a saved detail page with no network. */
export function parseJobrightSignalDetail(html: string, pageUrl: string): JobrightSignalDetail {
  const data = nextDataOf(html);
  const jobPath = ["props", "pageProps", "dataSource", "jobResult"];
  const companyPath = ["props", "pageProps", "dataSource", "companyResult"];

  // extractOriginalJobPost returns any well-formed URL it finds. An aggregator
  // link is never an Apply destination, so it is rejected here rather than
  // being allowed to masquerade as the employer's own posting.
  const original = extractOriginalJobPost(html, pageUrl);
  const officialOriginal =
    original && !isAggregatorUrl(original) && isValidOfficialApplicationUrl(original)
      ? original
      : null;

  return {
    companyDomain: employerDomainFrom(readString(data, [...companyPath, "companyURL"])),
    originalJobPostUrl: officialOriginal,
    postedText: readString(data, [...jobPath, "publishTimeDesc"]),
    removedAtSource: readBoolean(data, [...jobPath, "isDeleted"]),
  };
}

export function jobrightDetailUrl(signalJobId: string): string {
  return `https://jobright.ai/jobs/info/${encodeURIComponent(signalJobId)}`;
}

/**
 * Fetch and parse one signal's detail page.
 *
 * Enrichment is best-effort by design: a failure here must degrade the signal
 * to "resolve from what the list gave us", never abort the radar tick.
 */
export async function fetchJobrightSignalDetail(
  signalJobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JobrightSignalDetail> {
  const url = jobrightDetailUrl(signalJobId);
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return EMPTY_SIGNAL_DETAIL;
    return parseJobrightSignalDetail(await response.text(), url);
  } catch {
    return EMPTY_SIGNAL_DETAIL;
  }
}
