import { parseFirstSourceDate } from "@/lib/sync/sourceDate";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const INDEED_BASE = "https://www.indeed.com/jobs";
const MAX_PAGES_PER_QUERY = 2;
const PAGE_SIZE = 10;
const REQUEST_DELAY_MS = 800;

/**
 * Indeed is used only as a discovery signal. We intentionally never fetch an
 * Indeed /viewjob or /job detail URL and never expose an Indeed URL as Apply.
 * A candidate only reaches Discover after discoveryResolution independently
 * matches it to a live employer/ATS posting.
 */
export type RawIndeedDiscoveryJob = {
  sourceJobId: string;
  title: string;
  company: string;
  location: string | null;
  postedAt: Date | null;
  postedAtText: string | null;
  sourceQueryUrl: string;
};

const SEARCH_QUERIES = [
  "engineering internship",
  "electrical engineering intern",
  "computer engineering intern",
  "software engineering intern",
  "mechanical engineering intern",
  "aerospace engineering intern",
  "systems engineering intern",
  "firmware engineering intern",
  "hardware engineering intern",
  "manufacturing engineering intern",
] as const;

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
}

function visibleText(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function attrValue(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`${name}=["']([^"']+)["']`, "i"));
  return match?.[1] ? decodeHtml(match[1]).trim() : null;
}

function firstMatch(block: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = block.match(pattern);
    if (match?.[1]) {
      const text = visibleText(match[1]);
      if (text) return text;
    }
  }
  return null;
}

function titleFromAnchor(anchorTag: string, anchorBody: string): string | null {
  const bodyTitle = firstMatch(anchorBody, [
    /<span\b[^>]*title=["']([^"']+)["'][^>]*>/i,
    /<span\b[^>]*>([\s\S]*?)<\/span>/i,
  ]);
  if (bodyTitle) return bodyTitle;
  const aria = attrValue(anchorTag, "aria-label");
  if (aria) return aria.replace(/^full details of\s+/i, "").trim();
  const text = visibleText(anchorBody);
  return text || null;
}

/**
 * Parse one public Indeed search-results document. Current Indeed HTML exposes
 * a stable job key on result anchors (`data-jk`) plus semantic test ids for
 * company/location. The parser also accepts common legacy class names so a
 * small markup refresh does not zero the feed immediately.
 */
export function parseIndeedSearchPage(
  html: string,
  sourceQueryUrl: string,
  capturedAt: Date = new Date(),
): RawIndeedDiscoveryJob[] {
  const jobs: RawIndeedDiscoveryJob[] = [];
  const seen = new Set<string>();
  const anchorRe = /<a\b([^>]*\bdata-jk=["'][^"']+["'][^>]*)>([\s\S]*?)<\/a>/gi;
  const anchors = [...html.matchAll(anchorRe)];

  for (let index = 0; index < anchors.length; index += 1) {
    const match = anchors[index]!;
    const anchorTag = match[1] ?? "";
    const anchorBody = match[2] ?? "";
    const sourceJobId = attrValue(anchorTag, "data-jk");
    if (!sourceJobId || seen.has(sourceJobId)) continue;

    const title = titleFromAnchor(anchorTag, anchorBody);
    if (!title) continue;

    const start = (match.index ?? 0) + match[0].length;
    const nextIndex = anchors[index + 1]?.index ?? Math.min(html.length, start + 9000);
    const block = html.slice(start, Math.min(nextIndex, start + 9000));

    const company = firstMatch(block, [
      /<span\b[^>]*data-testid=["']company-name["'][^>]*>([\s\S]*?)<\/span>/i,
      /<span\b[^>]*class=["'][^"']*companyName[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
      /<a\b[^>]*data-testid=["']company-name["'][^>]*>([\s\S]*?)<\/a>/i,
    ]);
    if (!company) continue;

    const location = firstMatch(block, [
      /<div\b[^>]*data-testid=["']text-location["'][^>]*>([\s\S]*?)<\/div>/i,
      /<div\b[^>]*class=["'][^"']*companyLocation[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    ]);

    const postedText = firstMatch(block, [
      /<span\b[^>]*data-testid=["']myJobsStateDate["'][^>]*>([\s\S]*?)<\/span>/i,
      /<span\b[^>]*class=["'][^"']*date[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
    ]);
    const cleanedPostedText = postedText
      ?.replace(/^EmployerActive\s*/i, "")
      .replace(/^Posted\s*/i, "")
      .trim() || null;
    const sourceDate = parseFirstSourceDate([cleanedPostedText], capturedAt);

    seen.add(sourceJobId);
    jobs.push({
      sourceJobId: `indeed:${sourceJobId}`,
      title,
      company,
      location,
      postedAt: sourceDate.sourcePostedAt,
      postedAtText: sourceDate.sourcePostedText,
      sourceQueryUrl,
    });
  }

  return jobs;
}

function searchUrl(query: string, page: number): string {
  const url = new URL(INDEED_BASE);
  url.searchParams.set("q", query);
  url.searchParams.set("l", "United States");
  url.searchParams.set("sort", "date");
  url.searchParams.set("fromage", "30");
  if (page > 0) url.searchParams.set("start", String(page * PAGE_SIZE));
  // Keep one parameter after start so the URL matches Indeed's explicit
  // robots Allow forms for bounded pagination such as &start=10&.
  url.searchParams.set("vjk", "");
  return url.toString();
}

async function fetchSearchPage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) return null;
    return await response.text();
  } catch {
    return null;
  }
}

function identity(job: RawIndeedDiscoveryJob): string {
  return `${job.company}|${job.title}|${job.location ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export async function fetchIndeedEngineeringInternships(): Promise<{
  jobs: RawIndeedDiscoveryJob[];
  queriesAttempted: number;
  pagesFetched: number;
}> {
  const capturedAt = new Date();
  const result: RawIndeedDiscoveryJob[] = [];
  const seenJobs = new Set<string>();
  let pagesFetched = 0;

  for (const query of SEARCH_QUERIES) {
    for (let page = 0; page < MAX_PAGES_PER_QUERY; page += 1) {
      const url = searchUrl(query, page);
      const html = await fetchSearchPage(url);
      if (!html) break;
      pagesFetched += 1;

      for (const job of parseIndeedSearchPage(html, url, capturedAt)) {
        const key = identity(job);
        if (seenJobs.has(key)) continue;
        seenJobs.add(key);
        result.push(job);
      }

      if (page + 1 < MAX_PAGES_PER_QUERY) {
        await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
      }
    }
  }

  return {
    jobs: result,
    queriesAttempted: SEARCH_QUERIES.length,
    pagesFetched,
  };
}
