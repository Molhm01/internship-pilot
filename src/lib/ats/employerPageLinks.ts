// Job postings read from the links on an employer's OWN careers page.
//
// This exists because of a pattern that turns out to be very common: the
// employer's ATS refuses automated reads, but the employer's own careers page —
// which nobody protects — server-renders a link to every open posting on that
// same ATS.
//
// Walter P Moore is the case that motivated it. Every URL shape on
// careers-walterpmoore.icims.com answers HTTP 405 "Human Verification", even
// from a real headless browser. Meanwhile walterpmoore.com/careers is plain
// HTML containing:
//
//   https://careers-walterpmoore.icims.com/jobs/4201/cad-tech-intern---public-works/job
//
// which is a valid, official, job-specific application URL. So the employer's
// page is not merely a route to the board — for a walled vendor it IS the
// readable index of the board.
//
// Only links that already pass isValidOfficialApplicationUrl are kept, so this
// can never produce a careers landing page or a search URL as a destination.

import type { AtsJob } from "@/lib/ats/types";
import {
  isAggregatorUrl,
  isValidOfficialApplicationUrl,
} from "@/lib/applications/officialDestination";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MAX_JOBS = 80;
const INTERNSHIP_TITLE = /intern|co-?op|student|apprentice/i;

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, decimal: string) => String.fromCodePoint(Number(decimal)));
}

function visibleText(html: string): string {
  return decodeHtml(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A readable title for a posting whose link text was empty or unhelpful.
 *
 * ATS job URLs embed a slug — ".../jobs/4201/cad-tech-intern---public-works/job"
 * — which is a perfectly good title once the id and trailing segment are
 * dropped.
 */
export function titleFromJobUrl(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const segments = pathname.split("/").filter(Boolean);
  // Prefer the longest slug-looking segment that is not a bare id or a verb.
  const candidates = segments.filter(
    (segment) => /[a-z]/i.test(segment) && !/^\d+$/.test(segment) && !/^(job|jobs|apply|login)$/i.test(segment),
  );
  const slug = candidates.sort((a, b) => b.length - a.length)[0];
  if (!slug) return null;
  const words = decodeURIComponent(slug)
    .replace(/[_+]+/g, "-")
    .split(/-+/)
    .filter(Boolean);
  if (words.length < 2) return null;
  return words
    .map((word) => (word.length <= 2 ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * Extract official job postings linked from one careers page.
 *
 * `internshipsOnly` keeps the result proportionate: a large employer page can
 * link hundreds of roles, and the fresh radar only ever matches internships.
 */
export function extractOfficialJobLinks(
  html: string,
  pageUrl: string,
  companyName: string,
  internshipsOnly = true,
): AtsJob[] {
  const jobs: AtsJob[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    const rawHref = match[1];
    if (!rawHref) continue;

    let applyUrl: string;
    try {
      const url = new URL(decodeHtml(rawHref), pageUrl);
      url.hash = "";
      applyUrl = url.toString();
    } catch {
      continue;
    }

    if (isAggregatorUrl(applyUrl) || !isValidOfficialApplicationUrl(applyUrl)) continue;
    if (seen.has(applyUrl)) continue;

    const linkText = visibleText(match[2] ?? "");
    const title =
      linkText.length >= 4 && linkText.length <= 160 ? linkText : titleFromJobUrl(applyUrl);
    if (!title) continue;
    if (internshipsOnly && !INTERNSHIP_TITLE.test(title) && !INTERNSHIP_TITLE.test(applyUrl)) {
      continue;
    }

    seen.add(applyUrl);
    jobs.push({
      sourceJobId: applyUrl,
      requisitionId: applyUrl.match(/\/jobs?\/(\d{3,})(?:\/|$)/)?.[1] ?? null,
      title,
      company: companyName,
      // A link on a listing page rarely carries a location. Leaving this null is
      // correct: the matcher treats an unknown location as "no conflict" rather
      // than inventing one, and the title gate still has to be satisfied.
      location: null,
      workplaceType: null,
      applyUrl,
      description: "",
      postedAt: null,
      postedAtText: null,
    });
    if (jobs.length >= MAX_JOBS) break;
  }

  return jobs;
}

/** Fetch one employer careers page and read the official job links on it. */
export async function listEmployerPageJobs(
  careersUrl: string,
  companyName: string,
): Promise<AtsJob[]> {
  try {
    const response = await fetch(careersUrl, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return [];
    const html = await response.text();
    return extractOfficialJobLinks(html, response.url || careersUrl, companyName);
  } catch {
    return [];
  }
}

type EmployerSearchResult = { url: string; title: string };

function normalizedTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Read an employer-owned site-search form without assuming its query contract.
 * The action and input name must both be present in the page HTML, and the
 * action must remain on the employer's origin.
 */
export function employerSearchUrl(
  html: string,
  pageUrl: string,
  query: string,
): string | null {
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attributes = form[1] ?? "";
    const body = form[2] ?? "";
    const action = attributes.match(/\baction=["']([^"']+)["']/i)?.[1];
    const input = body.match(/<input\b[^>]*\bname=["']([^"']+)["'][^>]*>/i)?.[1];
    if (!action || !input || !/^(?:q|query|search)$/i.test(input)) continue;
    try {
      const base = new URL(pageUrl);
      const target = new URL(decodeHtml(action), base);
      if (target.origin !== base.origin) continue;
      target.searchParams.set(input, query);
      return target.toString();
    } catch {
      continue;
    }
  }
  return null;
}

/** Same-origin Search page explicitly linked by the employer careers page. */
export function employerSearchPageUrl(html: string, pageUrl: string): string | null {
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return null;
  }
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    try {
      const url = new URL(decodeHtml(match[1] ?? ""), pageUrl);
      if (url.origin === origin && /\/search\/?$/i.test(url.pathname)) return url.toString();
    } catch {
      continue;
    }
  }
  return null;
}

/** Exact-title employer job pages returned by the employer's own site search. */
export function extractEmployerSearchResults(
  html: string,
  searchUrl: string,
  query: string,
): EmployerSearchResult[] {
  const results: EmployerSearchResult[] = [];
  const seen = new Set<string>();
  const wanted = normalizedTitle(query);
  let origin: string;
  try {
    origin = new URL(searchUrl).origin;
  } catch {
    return [];
  }

  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,500}?)<\/a>/gi)) {
    const title = visibleText(match[2] ?? "");
    if (!title || normalizedTitle(title) !== wanted) continue;
    try {
      const url = new URL(decodeHtml(match[1] ?? ""), searchUrl);
      if (url.origin !== origin || !/\/(?:careers\/openings|jobs?)\//i.test(url.pathname)) continue;
      url.hash = "";
      const key = url.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ url: key, title });
    } catch {
      continue;
    }
    if (results.length >= 8) break;
  }
  return results;
}

/**
 * Search an employer-owned mirror for a signal the configured iCIMS board did
 * not enumerate. This does not touch the verification wall: it follows the
 * employer's own public search form to its own job page, then reads the
 * official iCIMS Apply link that page publishes.
 */
export async function searchEmployerMirrorJobs(
  careersUrl: string,
  companyName: string,
  query: string,
  allowedApplyHost: string,
): Promise<AtsJob[]> {
  try {
    const careersResponse = await fetch(careersUrl, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!careersResponse.ok) return [];
    const careersHtml = await careersResponse.text();
    const finalCareersUrl = careersResponse.url || careersUrl;
    let searchUrl = employerSearchUrl(careersHtml, finalCareersUrl, query);
    if (!searchUrl) {
      const searchPageUrl = employerSearchPageUrl(careersHtml, finalCareersUrl);
      if (!searchPageUrl) return [];
      const searchPageResponse = await fetch(searchPageUrl, {
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      if (!searchPageResponse.ok) return [];
      searchUrl = employerSearchUrl(
        await searchPageResponse.text(),
        searchPageResponse.url || searchPageUrl,
        query,
      );
    }
    if (!searchUrl) return [];

    const searchResponse = await fetch(searchUrl, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!searchResponse.ok) return [];
    const results = extractEmployerSearchResults(
      await searchResponse.text(),
      searchResponse.url || searchUrl,
      query,
    );

    const jobs: AtsJob[] = [];
    const seen = new Set<string>();
    for (const result of results) {
      const detailResponse = await fetch(result.url, {
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      if (!detailResponse.ok) continue;
      const detailUrl = detailResponse.url || result.url;
      const linked = extractOfficialJobLinks(
        await detailResponse.text(),
        detailUrl,
        companyName,
        false,
      );
      for (const job of linked) {
        let host: string;
        try {
          host = new URL(job.applyUrl).hostname.toLowerCase();
        } catch {
          continue;
        }
        if (host !== allowedApplyHost.toLowerCase() || seen.has(job.applyUrl)) continue;
        seen.add(job.applyUrl);
        jobs.push({ ...job, title: result.title });
      }
    }
    return jobs;
  } catch {
    return [];
  }
}
