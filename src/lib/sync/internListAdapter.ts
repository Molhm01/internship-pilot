// Source adapter for the "Engineering and Development" internship feed shown
// at https://www.intern-list.com/?k=eng
//
// That page itself is a thin Webflow shell: its "eng" tab loads an iframe
// pointing at https://jobright.ai/minisites-jobs/intern/us/engineering_development
// which is the actual public listing. That page happens to embed its job data
// as server-rendered JSON (Next.js __NEXT_DATA__), so a plain HTTP fetch
// already exposes everything a visitor sees — no JS execution required. We
// only fall back to Playwright (rendering the real public page) if that ever
// stops being true.
//
// Scope note: jobright.ai's robots.txt disallows /api/* for everyone and
// specifically disallows /jobs/ for ClaudeBot. The compliant, non-JS page
// load above only ever exposes the newest ~50 postings for this category
// (there is no further pagination reachable without hitting /api/*), so a
// "sync" here means "the newest ~50 right now" repeated hourly, not one
// giant backfill.

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

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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
  // The array index is the source's own ordering — the row the user sees at
  // the top of intern-list.com is index 0. It is preserved so the feed can
  // fall back to source order when timestamps tie or are missing.
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
    // The minisite serves `postedDate` as epoch milliseconds — an absolute
    // instant, which is what the "38 minutes ago" text on the page is rendered
    // from. The remaining names are accepted because the payload has carried
    // relative/absolute STRING forms in the past; anything textual is resolved
    // against this sync's capture time, once, here.
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
// `capturedAt` is the moment the payload was READ — relative date text is only
// meaningful against it, so callers pass their real fetch time.
export function parseInternListPayload(
  nextData: NextDataJobsPayload,
  capturedAt: Date = new Date(),
): RawInternListJob[] {
  const raw = nextData.props?.pageProps?.initialJobs;
  if (!Array.isArray(raw)) return [];
  return normalizeJobs(raw, capturedAt);
}

async function fetchViaHttp(capturedAt: Date): Promise<RawInternListJob[] | null> {
  const res = await fetch(MINISITE_URL, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(20_000),
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
    // Load the actual public page — the "eng" tab's iframe resolves to the
    // same minisite URL fetchViaHttp() already tried directly.
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

export async function fetchEngineeringInternships(): Promise<{
  jobs: RawInternListJob[];
  method: "http" | "playwright";
  /** When the source was read — the reference point for every relative date. */
  capturedAt: Date;
}> {
  const capturedAt = new Date();
  const httpResult = await fetchViaHttp(capturedAt);
  if (httpResult) return { jobs: httpResult, method: "http", capturedAt };
  const jobs = await fetchViaPlaywright(capturedAt);
  return { jobs, method: "playwright", capturedAt };
}
