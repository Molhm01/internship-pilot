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
