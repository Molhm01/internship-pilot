// Source adapter for engineering internships surfaced by Intern List.
//
// We intentionally use only public HTML surfaces:
// 1. Intern List's Engineering & Development tab, whose public iframe exposes
//    the newest engineering/development rows as server-rendered __NEXT_DATA__.
// 2. Intern List's own public, paginated SWE list. That page exposes many more
//    software/firmware/embedded roles than the iframe snapshot and requires no
//    private/API endpoints.
//
// These are DISCOVERY signals only. Nothing discovered here is user-visible
// until discoveryResolution independently resolves and verifies a live original
// employer/ATS posting.

import {
  isAggregatorUrl,
  isValidOfficialApplicationUrl,
} from "@/lib/applications/officialDestination";
import {
  parseFirstSourceDate,
  type SourceDateConfidence,
} from "@/lib/sync/sourceDate";

export const MINISITE_URL =
  "https://jobright.ai/minisites-jobs/intern/us/engineering_development?embed=true";
export const INTERN_LIST_URL = "https://www.intern-list.com/?k=eng";
export const INTERN_LIST_SWE_URL = "https://www.intern-list.com/swe-intern-list";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PUBLIC_LIST_MAX_PAGES = 3;
const PUBLIC_LIST_MAX_JOBS = 300;

export type RawInternListJob = {
  sourceJobId: string;
  title: string;
  company: string;
  location: string | null;
  workModel: string | null;
  postedAt: Date | null;
  /** Canonical source posting instant, resolved against the capture time. */
  sourcePostedAt: Date | null;
  /** The source's own date wording, when it gave text rather than a timestamp. */
  sourcePostedText: string | null;
  sourceDateConfidence: SourceDateConfidence;
  /** Position in the source's list — 0 is the top row of the newest sync. */
  sourceRowIndex: number;
  hireTime: string | null;
  salary: string | null;
  qualifications: string;
  applyUrl: string | null;
  sourceListingUrl?: string | null;
  officialApplicationUrl?: string | null;
  originalJobPostUrl?: string | null;
  h1bSponsored: string | null;
};

type NextDataJobsPayload = {
  props?: { pageProps?: { initialJobs?: unknown[]; initialTotal?: number } };
};

export function extractNextData(html: string): NextDataJobsPayload | null {
  const marker = "__NEXT_DATA__";
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const scriptStart = html.indexOf(">", idx) + 1;
  const scriptEnd = html.indexOf("</script>", scriptStart);
  if (scriptStart <= 0 || scriptEnd === -1) return null;
  try {
    return JSON.parse(html.slice(scriptStart, scriptEnd)) as NextDataJobsPayload;
  } catch {
    return null;
  }
}

function normalizeJobs(raw: unknown[], capturedAt: Date): RawInternListJob[] {
  const jobs: RawInternListJob[] = [];
  for (const [sourceRowIndex, item] of raw.entries()) {
    if (!item || typeof item !== "object") continue;
    const j = item as Record<string, unknown>;
    if (typeof j.id !== "string" || typeof j.title !== "string" || typeof j.company !== "string") {
      continue;
    }
    const value = (...names: string[]): string | null => {
      for (const name of names) {
        if (typeof j[name] === "string" && j[name].trim()) return j[name].trim();
      }
      return null;
    };
    const applyUrl = value("applyUrl");
    const explicitOriginal = value("originalUrl", "originalJobPostUrl", "originalJobUrl");
    const explicitOfficial = value(
      "officialApplicationUrl",
      "outboundApplicationUrl",
      "outboundUrl",
      "atsUrl",
      "employerApplicationUrl",
      "applicationUrl",
    );
    const officialApplicationUrl = [
      explicitOfficial,
      explicitOriginal,
      applyUrl,
    ].find(isValidOfficialApplicationUrl) ?? null;
    const sourceListingUrl = [
      value("sourceListingUrl", "listingUrl"),
      applyUrl,
    ].find(isAggregatorUrl) ?? null;
    const sourceDate = parseFirstSourceDate(
      [
        j.postedDate,
        j.postedAt,
        j.publishedAt,
        j.datePosted,
        j.postedDateText,
        j.postedText,
        j.postedTime,
        j.publishTimeDesc,
      ],
      capturedAt,
    );
    jobs.push({
      sourceJobId: j.id,
      title: j.title,
      company: j.company,
      location: typeof j.location === "string" ? j.location : null,
      workModel: typeof j.workModel === "string" ? j.workModel : null,
      postedAt: sourceDate.sourcePostedAt,
      sourcePostedAt: sourceDate.sourcePostedAt,
      sourcePostedText: sourceDate.sourcePostedText,
      sourceDateConfidence: sourceDate.sourceDateConfidence,
      sourceRowIndex,
      hireTime: typeof j.hireTime === "string" && j.hireTime ? j.hireTime : null,
      salary: typeof j.salary === "string" ? j.salary : null,
      qualifications: typeof j.qualifications === "string" ? j.qualifications : "",
      applyUrl,
      sourceListingUrl,
      officialApplicationUrl,
      originalJobPostUrl:
        explicitOriginal && isValidOfficialApplicationUrl(explicitOriginal)
          ? explicitOriginal
          : null,
      h1bSponsored: typeof j.h1bSponsored === "string" ? j.h1bSponsored : null,
    });
  }
  return jobs;
}

// Pure function (no network) so tests can feed it a saved fixture directly.
export function parseInternListPayload(
  nextData: NextDataJobsPayload,
  capturedAt: Date = new Date(),
): RawInternListJob[] {
  const raw = nextData.props?.pageProps?.initialJobs;
  if (!Array.isArray(raw)) return [];
  return normalizeJobs(raw, capturedAt);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

function visibleText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

const MONTH_PATTERN =
  "January|February|March|April|May|June|July|August|September|October|November|December";
const PUBLIC_DATE_RE = new RegExp(`\\b(${MONTH_PATTERN})\\s+\\d{1,2},\\s+20\\d{2}\\b`, "i");

function titleCaseSlug(value: string): string {
  return decodeURIComponent(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function fallbackIdentityFromDetailUrl(detailUrl: string): {
  sourceJobId: string;
  title: string;
  company: string;
} | null {
  try {
    const pathname = new URL(detailUrl).pathname;
    const slug = pathname.split("/").filter(Boolean).at(-1);
    if (!slug) return null;
    const match = slug.match(/^(.+)_at_(.+)_(\d+)$/i);
    if (!match) return null;
    return {
      sourceJobId: `intern-list-public:${match[3]}`,
      title: titleCaseSlug(match[1]),
      company: titleCaseSlug(match[2]),
    };
  } catch {
    return null;
  }
}

/**
 * Parse Intern List's public Webflow SWE listing without depending on private
 * APIs. Each card links to a stable /swe-intern-list/<slug> detail page.
 */
export function parsePublicInternListPage(
  html: string,
  pageUrl: string,
  capturedAt: Date,
  rowOffset = 0,
): RawInternListJob[] {
  const jobs: RawInternListJob[] = [];
  const seen = new Set<string>();
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorRe)) {
    const rawHref = match[1];
    if (!rawHref) continue;

    let detailUrl: string;
    try {
      const url = new URL(decodeHtml(rawHref), pageUrl);
      if (url.hostname !== "www.intern-list.com" && url.hostname !== "intern-list.com") continue;
      if (!/^\/swe-intern-list\/[^/]+\/?$/.test(url.pathname)) continue;
      url.hash = "";
      detailUrl = url.toString();
    } catch {
      continue;
    }

    if (seen.has(detailUrl)) continue;
    seen.add(detailUrl);

    const fallback = fallbackIdentityFromDetailUrl(detailUrl);
    if (!fallback) continue;

    const text = visibleText(match[2] ?? "");
    const dateMatch = text.match(PUBLIC_DATE_RE);
    const dateText = dateMatch?.[0] ?? null;
    let title = fallback.title;
    let company = fallback.company;

    if (dateMatch?.index !== undefined) {
      const before = text.slice(0, dateMatch.index).trim();
      const after = text.slice(dateMatch.index + dateMatch[0].length).trim();
      if (before) title = before;
      if (after) company = after;
    }

    const sourceDate = parseFirstSourceDate([dateText], capturedAt);
    jobs.push({
      sourceJobId: fallback.sourceJobId,
      title,
      company,
      location: null,
      workModel: null,
      postedAt: sourceDate.sourcePostedAt,
      sourcePostedAt: sourceDate.sourcePostedAt,
      sourcePostedText: sourceDate.sourcePostedText,
      sourceDateConfidence: sourceDate.sourceDateConfidence,
      sourceRowIndex: rowOffset + jobs.length,
      hireTime: null,
      salary: null,
      qualifications: "",
      applyUrl: detailUrl,
      sourceListingUrl: detailUrl,
      officialApplicationUrl: null,
      originalJobPostUrl: null,
      h1bSponsored: null,
    });
  }

  return jobs;
}

function publicPaginationUrls(html: string, pageUrl: string): string[] {
  const urls = new Map<number, string>();
  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const rawHref = match[1];
    if (!rawHref) continue;
    try {
      const url = new URL(decodeHtml(rawHref), pageUrl);
      if (url.hostname !== "www.intern-list.com" && url.hostname !== "intern-list.com") continue;
      if (url.pathname.replace(/\/$/, "") !== "/swe-intern-list") continue;

      for (const [key, value] of url.searchParams.entries()) {
        if (!/(?:^|_)page$/i.test(key)) continue;
        const page = Number.parseInt(value, 10);
        if (Number.isFinite(page) && page > 1 && !urls.has(page)) urls.set(page, url.toString());
      }
    } catch {
      // Ignore unrelated/malformed links.
    }
  }
  return [...urls.entries()].sort(([a], [b]) => a - b).map(([, url]) => url);
}

async function fetchPublicInternListJobs(capturedAt: Date): Promise<RawInternListJob[]> {
  const queue = [INTERN_LIST_SWE_URL];
  const seenPages = new Set<string>();
  const seenJobs = new Set<string>();
  const jobs: RawInternListJob[] = [];

  while (queue.length > 0 && seenPages.size < PUBLIC_LIST_MAX_PAGES && jobs.length < PUBLIC_LIST_MAX_JOBS) {
    const pageUrl = queue.shift()!;
    if (seenPages.has(pageUrl)) continue;
    seenPages.add(pageUrl);

    const response = await fetch(pageUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!response.ok) continue;
    const html = await response.text();

    for (const job of parsePublicInternListPage(html, pageUrl, capturedAt, jobs.length)) {
      const key = job.sourceListingUrl ?? job.sourceJobId;
      if (seenJobs.has(key)) continue;
      seenJobs.add(key);
      jobs.push({ ...job, sourceRowIndex: jobs.length });
      if (jobs.length >= PUBLIC_LIST_MAX_JOBS) break;
    }

    for (const next of publicPaginationUrls(html, pageUrl)) {
      if (!seenPages.has(next) && !queue.includes(next)) queue.push(next);
    }
  }

  return jobs;
}

async function fetchViaHttp(capturedAt: Date): Promise<RawInternListJob[] | null> {
  const res = await fetch(MINISITE_URL, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const html = await res.text();
  const nextData = extractNextData(html);
  if (!nextData) return null;
  const jobs = parseInternListPayload(nextData, capturedAt);
  return jobs.length > 0 ? jobs : null;
}

async function fetchViaPlaywright(capturedAt: Date): Promise<RawInternListJob[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ userAgent: USER_AGENT });
    await page.goto(INTERN_LIST_URL, { waitUntil: "networkidle", timeout: 30_000 });
    let target: import("playwright").Page | import("playwright").Frame | undefined = page
      .frames()
      .find((f) => f.url().includes("minisites-jobs"));
    if (!target) {
      await page.goto(MINISITE_URL, { waitUntil: "networkidle", timeout: 30_000 });
      target = page;
    }
    const nextData = await target.evaluate(() => {
      return (window as unknown as { __NEXT_DATA__?: unknown }).__NEXT_DATA__ ?? null;
    });
    if (!nextData) return [];
    return parseInternListPayload(nextData as NextDataJobsPayload, capturedAt);
  } finally {
    await browser.close();
  }
}

function normalizedIdentity(job: RawInternListJob): string {
  return `${job.company}|${job.title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function mergeDiscoveryJobs(primary: RawInternListJob[], supplemental: RawInternListJob[]): RawInternListJob[] {
  const result: RawInternListJob[] = [];
  const seenListingUrls = new Set<string>();
  const seenIdentities = new Set<string>();

  // Prefer the Engineering & Development minisite representation when the same
  // posting appears in both surfaces because it usually carries richer fields.
  for (const job of [...primary, ...supplemental]) {
    const listing = job.sourceListingUrl ?? null;
    const identity = normalizedIdentity(job);
    if ((listing && seenListingUrls.has(listing)) || seenIdentities.has(identity)) continue;
    if (listing) seenListingUrls.add(listing);
    seenIdentities.add(identity);
    result.push({ ...job, sourceRowIndex: result.length });
  }
  return result;
}

export async function fetchEngineeringInternships(): Promise<{
  jobs: RawInternListJob[];
  method: "http" | "playwright";
  /** When the source was read — the reference point for every relative date. */
  capturedAt: Date;
}> {
  const capturedAt = new Date();

  let primary = await fetchViaHttp(capturedAt);
  let method: "http" | "playwright" = "http";
  if (!primary) {
    primary = await fetchViaPlaywright(capturedAt);
    method = "playwright";
  }

  let publicJobs: RawInternListJob[] = [];
  try {
    publicJobs = await fetchPublicInternListJobs(capturedAt);
  } catch {
    // Public-list expansion is supplemental. A temporary Webflow failure must
    // never take down the core Engineering & Development source.
    publicJobs = [];
  }

  return {
    jobs: mergeDiscoveryJobs(primary ?? [], publicJobs),
    method,
    capturedAt,
  };
}
