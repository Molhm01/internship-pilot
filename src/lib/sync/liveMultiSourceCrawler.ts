import type { AtsJob } from "@/lib/ats/types";
import { listJobsForCompany } from "@/lib/ats";
import { prisma } from "@/lib/db";
import { promoteCanonicalDirectJob } from "@/lib/jobs/activeFeed";
import { isTargetEngineeringRole } from "@/lib/sync/classify";
import { inferResolvedSource } from "@/lib/sync/discoveryResolution";
import { fetchEngineeringInternships } from "@/lib/sync/internListAdapter";
import { liveJobBoardProfile, upsertClassifiedAtsJob } from "@/lib/sync/ingest";
import {
  employerAtsProvenance,
  parseFirstSourceDate,
  trustedRadarProvenance,
} from "@/lib/sync/sourceDate";
import {
  isAggregatorUrl,
  isValidOfficialApplicationUrl,
  stripTrackingParameters,
} from "@/lib/applications/officialDestination";
import {
  headlessChromiumLaunchArgs,
  resolveChromiumExecutablePath,
} from "@/lib/applications/chromiumExecutable";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const MULTI_SOURCE_STATUS_KEY = "liveDiscovery:multiSourceStatus";
const HOURS_6_MS = 6 * 60 * 60 * 1000;
const HOURS_24_MS = 24 * 60 * 60 * 1000;

export type LiveCrawlerSourceId =
  | "linkedin"
  | "indeed"
  | "handshake"
  | "intern-list"
  | "direct-ats";

export type CrawledLiveJob = {
  boardSource: LiveCrawlerSourceId;
  sourceJobId: string;
  title: string;
  company: string;
  location: string | null;
  listingUrl: string;
  officialApplyUrl: string | null;
  postedAt: Date | null;
  postedAtText: string | null;
  description: string;
  workplaceType: string | null;
};

export type MultiSourceChannelStatus = {
  source: LiveCrawlerSourceId;
  label: string;
  fetched: number;
  freshUnder6h: number;
  freshUnder24h: number;
  persisted: number;
  updated: number;
  status: "ok" | "partial" | "unavailable";
  checkedAt: string;
  note?: string;
};

export type MultiSourceCrawlSummary = {
  durationMs: number;
  totalFetched: number;
  freshUnder6h: number;
  freshUnder24h: number;
  newCount: number;
  updatedCount: number;
  channels: MultiSourceChannelStatus[];
};

const SOURCE_LABELS: Record<LiveCrawlerSourceId, string> = {
  linkedin: "LinkedIn",
  indeed: "Indeed",
  handshake: "Handshake",
  "intern-list": "Intern-List",
  "direct-ats": "Direct ATS",
};

const FAST_EMPLOYER_BOARDS: Array<{ name: string; atsType: string; atsIdentifier: string }> = [
  { name: "Stripe", atsType: "greenhouse", atsIdentifier: "stripe" },
  { name: "Figma", atsType: "greenhouse", atsIdentifier: "figma" },
  { name: "Databricks", atsType: "greenhouse", atsIdentifier: "databricks" },
  { name: "Cloudflare", atsType: "greenhouse", atsIdentifier: "cloudflare" },
  { name: "Scale AI", atsType: "greenhouse", atsIdentifier: "scaleai" },
  { name: "Discord", atsType: "greenhouse", atsIdentifier: "discord" },
  { name: "Coinbase", atsType: "greenhouse", atsIdentifier: "coinbase" },
  { name: "Datadog", atsType: "greenhouse", atsIdentifier: "datadog" },
  { name: "Roblox", atsType: "greenhouse", atsIdentifier: "roblox" },
  { name: "Anthropic", atsType: "greenhouse", atsIdentifier: "anthropic" },
  { name: "Ramp", atsType: "ashby", atsIdentifier: "ramp" },
  { name: "Notion", atsType: "ashby", atsIdentifier: "notion" },
  { name: "OpenAI", atsType: "ashby", atsIdentifier: "openai" },
  { name: "Perplexity", atsType: "ashby", atsIdentifier: "perplexity" },
  { name: "Cursor", atsType: "ashby", atsIdentifier: "cursor" },
  { name: "Modal", atsType: "ashby", atsIdentifier: "modal" },
  { name: "Cohere", atsType: "ashby", atsIdentifier: "cohere" },
];

function decodeHtml(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function parseRelativePostedTime(text: string | null | undefined, capturedAt: Date): Date | null {
  if (!text) return null;
  const clean = text.trim().toLowerCase();
  if (!clean) return null;
  if (/\b(?:just posted|just now|moments? ago|active today|today|posted today|0d)\b/.test(clean)) {
    return new Date(capturedAt.getTime() - 10 * 60 * 1000);
  }
  const parsed = parseFirstSourceDate([clean], capturedAt);
  if (parsed.sourcePostedAt) return parsed.sourcePostedAt;

  const shortMatch = clean.match(/\b(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/);
  if (!shortMatch) return null;
  const n = Number(shortMatch[1]);
  const unit = shortMatch[2]!;
  if (!Number.isFinite(n) || n < 0) return null;
  if (unit.startsWith("m")) return new Date(capturedAt.getTime() - n * 60_000);
  if (unit.startsWith("h")) return new Date(capturedAt.getTime() - n * 3_600_000);
  if (unit.startsWith("d")) return new Date(capturedAt.getTime() - n * 86_400_000);
  return null;
}

function looksLikeEngineeringIntern(title: string): boolean {
  if (!/\b(intern|internship|co-op|coop|apprentice)\b/i.test(title)) return false;
  return isTargetEngineeringRole(title, "");
}

function inferWorkplaceType(text: string | null | undefined): string | null {
  if (!text) return null;
  if (/\bremote\b/i.test(text)) return "Remote";
  if (/\bhybrid\b/i.test(text)) return "Hybrid";
  return null;
}

export function parseLinkedInGuestCards(html: string, capturedAt = new Date()): CrawledLiveJob[] {
  const results: CrawledLiveJob[] = [];
  const cards = html.match(/<li[\s\S]*?<\/li>/gi) ?? [];
  const blocks = cards.length > 0 ? cards : html.split(/class="base-card/i).slice(1);

  for (const block of blocks) {
    const hrefMatch = block.match(/href=["'](https:\/\/www\.linkedin\.com\/jobs\/view\/[^"'?#]+|https:\/\/[a-z]+\.linkedin\.com\/jobs\/view\/[^"'?#]+)[^"']*["']/i);
    if (!hrefMatch) continue;
    const rawHref = hrefMatch[1]!.replace(/&amp;/g, "&");
    const idMatch = rawHref.match(/-(\d+)(?:\/|$)/) ?? rawHref.match(/\/jobs\/view\/(\d+)/);
    const externalId = idMatch?.[1] ?? hashText(rawHref);

    const titleMatch =
      block.match(/class="base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h\d>/i) ??
      block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const companyMatch =
      block.match(/class="base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h\d>/i) ??
      block.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);
    const locationMatch = block.match(/class="job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const timeAttrMatch = block.match(/<time[^>]*datetime=["']([^"']+)["'][^>]*>([\s\S]*?)<\/time>/i);
    const timeBodyMatch = block.match(/<time[^>]*>([\s\S]*?)<\/time>/i);

    const title = titleMatch ? decodeHtml(titleMatch[1]!) : "";
    const company = companyMatch ? decodeHtml(companyMatch[1]!) : "";
    const location = locationMatch ? decodeHtml(locationMatch[1]!) || null : null;
    if (!title || !company || !looksLikeEngineeringIntern(title)) continue;

    const datetimeAttr = timeAttrMatch?.[1]?.trim() ?? null;
    const relativeText = timeAttrMatch ? decodeHtml(timeAttrMatch[2]!) : timeBodyMatch ? decodeHtml(timeBodyMatch[1]!) : null;
    const postedDate =
      parseRelativePostedTime(relativeText, capturedAt) ??
      (datetimeAttr ? parseFirstSourceDate([datetimeAttr], capturedAt).sourcePostedAt : null) ??
      new Date(capturedAt.getTime() - 4 * 60 * 60 * 1000);

    results.push({
      boardSource: "linkedin",
      sourceJobId: `linkedin:${externalId}`,
      title,
      company,
      location,
      listingUrl: `https://www.linkedin.com/jobs/view/${externalId}/`,
      officialApplyUrl: null,
      postedAt: postedDate,
      postedAtText: relativeText ?? datetimeAttr ?? "Recent",
      description: `${title} at ${company}${location ? ` (${location})` : ""}. Discovered live on LinkedIn.`,
      workplaceType: inferWorkplaceType(`${title} ${location ?? ""}`),
    });
  }
  return results;
}

export function extractLinkedInExternalApplyUrl(detailHtml: string): string | null {
  const applyMatch =
    detailHtml.match(/applyUrl["']?\s*[:=]\s*["']([^"']+)["']/i) ??
    detailHtml.match(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*data-tracking-control-name="public_jobs_apply-link-offsite/i);
  if (!applyMatch) return null;
  let candidate = applyMatch[1]!.replace(/\\u002F/gi, "/").replace(/&amp;/g, "&");
  try {
    const parsed = new URL(candidate);
    const redirected = parsed.searchParams.get("url");
    if (redirected) candidate = redirected;
  } catch {
    return null;
  }
  if (!candidate.startsWith("https://") || isAggregatorUrl(candidate)) return null;
  return isValidOfficialApplicationUrl(candidate) ? stripTrackingParameters(candidate) : null;
}

export function parseIndeedSearchCards(html: string, capturedAt = new Date()): CrawledLiveJob[] {
  const results: CrawledLiveJob[] = [];
  const blocks = html.split(/data-jk=["']([a-zA-Z0-9_-]+)["']/g);
  for (let i = 1; i < blocks.length; i += 2) {
    const jobKey = blocks[i]!;
    const snippet = (blocks[i + 1] ?? "").slice(0, 4000);
    const titleMatch =
      snippet.match(/class="[^"]*jobTitle[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i) ??
      snippet.match(/<a[^>]+data-jk[^>]*>([\s\S]*?)<\/a>/i) ??
      snippet.match(/title=["']([^"']+)["']/i);
    const companyMatch =
      snippet.match(/data-testid="company-name"[^>]*>([\s\S]*?)<\/span>/i) ??
      snippet.match(/class="[^"]*companyName[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const locationMatch =
      snippet.match(/data-testid="text-location"[^>]*>([\s\S]*?)<\/div>/i) ??
      snippet.match(/class="[^"]*companyLocation[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const dateMatch =
      snippet.match(/data-testid="myJobsStateDate"[^>]*>([\s\S]*?)<\/span>/i) ??
      snippet.match(/class="[^"]*date[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ??
      snippet.match(/(Just posted|Today|Posted\s+\d+\s+(?:hour|hours|minute|minutes|day|days)\s+ago|Active\s+\d+\s+days?\s+ago)/i);

    const title = titleMatch ? decodeHtml(titleMatch[1]!) : "";
    const company = companyMatch ? decodeHtml(companyMatch[1]!) : "";
    const location = locationMatch ? decodeHtml(locationMatch[1]!) || null : null;
    if (!title || !company || !looksLikeEngineeringIntern(title)) continue;

    const postedText = dateMatch ? decodeHtml(dateMatch[1]!) : "Just posted";
    const postedAt =
      parseRelativePostedTime(postedText, capturedAt) ??
      new Date(capturedAt.getTime() - 2 * 60 * 60 * 1000);

    results.push({
      boardSource: "indeed",
      sourceJobId: `indeed:${jobKey}`,
      title,
      company,
      location,
      listingUrl: `https://www.indeed.com/viewjob?jk=${encodeURIComponent(jobKey)}`,
      officialApplyUrl: null,
      postedAt,
      postedAtText: postedText,
      description: `${title} at ${company}${location ? ` (${location})` : ""}. Discovered live on Indeed.`,
      workplaceType: inferWorkplaceType(`${title} ${location ?? ""}`),
    });
  }
  return results;
}

export function parseHandshakePostings(htmlOrJson: string, capturedAt = new Date()): CrawledLiveJob[] {
  const results: CrawledLiveJob[] = [];
  const seen = new Set<string>();

  // Strategy 1: JSON-LD JobPosting scripts
  const ldMatches = htmlOrJson.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of ldMatches) {
    try {
      const parsed = JSON.parse(match[1]!) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        if (rec["@type"] !== "JobPosting") continue;
        const title = typeof rec.title === "string" ? rec.title.trim() : "";
        const org = rec.hiringOrganization as Record<string, unknown> | undefined;
        const company = typeof org?.name === "string" ? org.name.trim() : "";
        if (!title || !company || !looksLikeEngineeringIntern(title)) continue;

        const rawUrl = typeof rec.url === "string" ? rec.url.trim() : `https://app.joinhandshake.com/stu/postings`;
        const id = hashText(`${company}|${title}|${rawUrl}`);
        if (seen.has(id)) continue;
        seen.add(id);

        const jobLoc = rec.jobLocation as Record<string, unknown> | undefined;
        const addr = jobLoc?.address as Record<string, unknown> | undefined;
        const locality = typeof addr?.addressLocality === "string" ? addr.addressLocality : "";
        const region = typeof addr?.addressRegion === "string" ? addr.addressRegion : "";
        const location = [locality, region].filter(Boolean).join(", ") || null;
        const datePosted = typeof rec.datePosted === "string" ? rec.datePosted : null;
        const postedAt =
          (datePosted ? parseFirstSourceDate([datePosted], capturedAt).sourcePostedAt : null) ??
          new Date(capturedAt.getTime() - 3 * 60 * 60 * 1000);

        results.push({
          boardSource: "handshake",
          sourceJobId: `handshake:${id}`,
          title,
          company,
          location,
          listingUrl: rawUrl,
          officialApplyUrl: isValidOfficialApplicationUrl(rawUrl) ? stripTrackingParameters(rawUrl) : null,
          postedAt,
          postedAtText: datePosted ?? "Recent",
          description:
            typeof rec.description === "string" && rec.description.trim().length > 20
              ? decodeHtml(rec.description).slice(0, 4000)
              : `${title} at ${company}. Discovered on Handshake.`,
          workplaceType: inferWorkplaceType(`${title} ${location ?? ""}`),
        });
      }
    } catch {
      // Ignore invalid JSON-LD block
    }
  }

  // Strategy 2: Handshake posting card links
  const linkMatches = htmlOrJson.matchAll(
    /<a[^>]+href=["'](https?:\/\/[^"']*joinhandshake\.com\/(?:stu\/)?(?:jobs|postings)\/(\d+)[^"']*|\/(?:stu\/)?(?:jobs|postings)\/(\d+)[^"']*)["'][^>]*>([\s\S]{10,1200}?)<\/a>/gi,
  );
  for (const match of linkMatches) {
    const href = match[1]!;
    const numericId = match[2] ?? match[3] ?? hashText(href);
    const bodyText = decodeHtml(match[4]!);
    if (!bodyText || seen.has(numericId)) continue;
    const parts = bodyText.split(/\s+[·•|-]\s+|\s{2,}/).map((s) => s.trim()).filter(Boolean);
    const title = parts[0] ?? bodyText;
    const company = parts[1] ?? "Handshake Employer";
    if (!looksLikeEngineeringIntern(title)) continue;
    seen.add(numericId);
    const listingUrl = href.startsWith("http") ? href : `https://app.joinhandshake.com${href}`;
    results.push({
      boardSource: "handshake",
      sourceJobId: `handshake:${numericId}`,
      title,
      company,
      location: parts[2] ?? null,
      listingUrl,
      officialApplyUrl: null,
      postedAt: new Date(capturedAt.getTime() - 4 * 60 * 60 * 1000),
      postedAtText: "Recent",
      description: `${title} at ${company}. Discovered live on Handshake.`,
      workplaceType: inferWorkplaceType(bodyText),
    });
  }

  return results;
}

async function fetchHtmlWithFallback(url: string, timeoutMs = 8_000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const text = await res.text();
      if (text && !/cf-browser-verification|captcha|just a moment/i.test(text.slice(0, 1200))) {
        return text;
      }
    }
  } catch {
    // Fall through to optional Chromium load
  }
  return null;
}

async function fetchUrlsWithSharedChromium(
  urls: string[],
  timeoutMs = 10_000,
): Promise<Map<string, string>> {
  const pages = new Map<string, string>();
  if (urls.length === 0) return pages;

  const executablePath = await resolveChromiumExecutablePath();
  if (!executablePath) return pages;

  let browser: import("playwright").Browser | null = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: headlessChromiumLaunchArgs(),
    });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
    });
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "stylesheet" || type === "font" || type === "media") {
        return route.abort();
      }
      return route.continue();
    });

    for (const url of urls) {
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await page.waitForTimeout(1_200);
        const content = await page.content();
        pages.set(url, content);
      } catch {
        // Non-fatal per URL
      } finally {
        await page.close().catch(() => undefined);
      }
    }
    await context.close().catch(() => undefined);
  } catch {
    // Headless Chromium unavailable in this environment
  } finally {
    await browser?.close().catch(() => undefined);
  }
  return pages;
}

async function crawlLinkedIn(capturedAt: Date): Promise<{ jobs: CrawledLiveJob[]; note?: string }> {
  const urls = [
    "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=software+engineer+intern&location=United+States&f_TPR=r86400&sortBy=DD",
    "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=AI+ML+engineer+intern&location=United+States&f_TPR=r86400&sortBy=DD",
  ];

  const htmls = await Promise.all(urls.map((u) => fetchHtmlWithFallback(u, 8_000)));
  const jobs: CrawledLiveJob[] = [];
  const needBrowserUrls: string[] = [];
  urls.forEach((url, idx) => {
    const html = htmls[idx];
    if (html && html.includes("jobs/view")) {
      jobs.push(...parseLinkedInGuestCards(html, capturedAt));
    } else {
      needBrowserUrls.push(url);
    }
  });

  if (jobs.length === 0 && needBrowserUrls.length > 0) {
    const rendered = await fetchUrlsWithSharedChromium(needBrowserUrls.slice(0, 1), 9_000);
    for (const html of rendered.values()) {
      jobs.push(...parseLinkedInGuestCards(html, capturedAt));
    }
  }

  // Enrich top 5 freshest LinkedIn cards with official external ATS URLs if available
  const topFive = jobs.slice(0, 5);
  await Promise.all(
    topFive.map(async (item) => {
      const id = item.sourceJobId.replace("linkedin:", "");
      if (!/^\d+$/.test(id)) return;
      const detailHtml = await fetchHtmlWithFallback(
        `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`,
        5_000,
      );
      if (detailHtml) {
        item.officialApplyUrl = extractLinkedInExternalApplyUrl(detailHtml);
      }
    }),
  );

  return {
    jobs,
    note: jobs.length > 0 ? undefined : "Rate-limited or empty LinkedIn guest window",
  };
}

async function crawlIndeed(capturedAt: Date): Promise<{ jobs: CrawledLiveJob[]; note?: string }> {
  const targetUrls = [
    "https://www.indeed.com/jobs?q=software+engineer+intern&fromage=1&sort=date",
  ];
  const jobs: CrawledLiveJob[] = [];
  const directHtml = await fetchHtmlWithFallback(targetUrls[0]!, 6_000);
  if (directHtml && directHtml.includes("data-jk")) {
    jobs.push(...parseIndeedSearchCards(directHtml, capturedAt));
  } else {
    const rendered = await fetchUrlsWithSharedChromium(targetUrls, 9_000);
    for (const html of rendered.values()) {
      jobs.push(...parseIndeedSearchCards(html, capturedAt));
    }
  }
  return {
    jobs,
    note: jobs.length > 0 ? undefined : "Indeed anti-bot check active",
  };
}

async function crawlHandshake(capturedAt: Date): Promise<{ jobs: CrawledLiveJob[]; note?: string }> {
  const urls = [
    "https://joinhandshake.com/explore",
    "https://app.joinhandshake.com/stu/postings",
  ];
  const jobs: CrawledLiveJob[] = [];
  const htmls = await Promise.all(urls.map((u) => fetchHtmlWithFallback(u, 6_000)));
  for (const html of htmls) {
    if (html) jobs.push(...parseHandshakePostings(html, capturedAt));
  }
  if (jobs.length === 0) {
    const rendered = await fetchUrlsWithSharedChromium(["https://joinhandshake.com/explore"], 8_000);
    for (const html of rendered.values()) {
      jobs.push(...parseHandshakePostings(html, capturedAt));
    }
  }
  return {
    jobs,
    note: jobs.length > 0 ? undefined : "Handshake public explore yielded no open JSON-LD roles",
  };
}

async function crawlInternListDirect(capturedAt: Date): Promise<{ jobs: CrawledLiveJob[]; note?: string }> {
  try {
    const { jobs: raw } = await fetchEngineeringInternships();
    const mapped: CrawledLiveJob[] = [];
    for (const row of raw.slice(0, 120)) {
      if (!isTargetEngineeringRole(row.title, row.qualifications)) continue;
      const officialUrl =
        row.officialApplicationUrl ??
        row.originalJobPostUrl ??
        (row.applyUrl && !isAggregatorUrl(row.applyUrl) && isValidOfficialApplicationUrl(row.applyUrl)
          ? row.applyUrl
          : null);
      const listingUrl = row.sourceListingUrl ?? row.applyUrl ?? officialUrl;
      if (!listingUrl) continue;
      mapped.push({
        boardSource: "intern-list",
        sourceJobId: `intern-list:${row.sourceJobId}`,
        title: row.title,
        company: row.company,
        location: row.location,
        listingUrl: stripTrackingParameters(listingUrl),
        officialApplyUrl: officialUrl ? stripTrackingParameters(officialUrl) : null,
        postedAt: row.sourcePostedAt ?? row.postedAt ?? capturedAt,
        postedAtText: row.sourcePostedText ?? "Recent",
        description: row.qualifications || "",
        workplaceType: row.workModel,
      });
    }
    return {
      jobs: mapped,
      note: mapped.length > 0 ? undefined : "Intern-List feed returned no matching roles",
    };
  } catch (err) {
    return { jobs: [], note: err instanceof Error ? err.message : "Intern-List unavailable" };
  }
}

async function crawlFastDirectAts(): Promise<{ jobs: CrawledLiveJob[]; note?: string }> {
  const jobs: CrawledLiveJob[] = [];
  await Promise.allSettled(
    FAST_EMPLOYER_BOARDS.map(async (board) => {
      try {
        const listed = await Promise.race([
          listJobsForCompany({
            name: board.name,
            atsType: board.atsType,
            atsIdentifier: board.atsIdentifier,
            careersUrl: null,
          }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 6_000)),
        ]);
        if (!listed?.supported) return;
        let perBoard = 0;
        for (const item of listed.jobs) {
          if (!isTargetEngineeringRole(item.title, item.description ?? "")) continue;
          if (!/\b(intern|internship|co-op|coop)\b/i.test(item.title)) continue;
          if (perBoard >= 5) break;
          perBoard += 1;
          jobs.push({
            boardSource: "direct-ats",
            sourceJobId: item.sourceJobId,
            title: item.title,
            company: board.name,
            location: item.location,
            listingUrl: item.applyUrl,
            officialApplyUrl: stripTrackingParameters(item.applyUrl),
            postedAt: item.postedAt ?? null,
            postedAtText: item.postedAtText ?? null,
            description: item.description ?? "",
            workplaceType: item.workplaceType,
          });
        }
      } catch {
        // Non-fatal per board
      }
    }),
  );
  return { jobs };
}

async function persistCrawledJobs(
  jobs: CrawledLiveJob[],
  now: Date,
): Promise<Map<LiveCrawlerSourceId, { newCount: number; updatedCount: number }>> {
  const stats = new Map<LiveCrawlerSourceId, { newCount: number; updatedCount: number }>([
    ["linkedin", { newCount: 0, updatedCount: 0 }],
    ["indeed", { newCount: 0, updatedCount: 0 }],
    ["handshake", { newCount: 0, updatedCount: 0 }],
    ["intern-list", { newCount: 0, updatedCount: 0 }],
    ["direct-ats", { newCount: 0, updatedCount: 0 }],
  ]);

  let idx = 0;
  const concurrency = Math.min(12, Math.max(1, jobs.length));
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (idx < jobs.length) {
        const item = jobs[idx++]!;
        const finalUrl = item.officialApplyUrl ?? item.listingUrl;
        const resolvedOfficial = item.officialApplyUrl ? inferResolvedSource(item.officialApplyUrl) : null;
        const isOfficial = Boolean(resolvedOfficial && resolvedOfficial.source !== "other");
        const source = resolvedOfficial ? resolvedOfficial.source : item.boardSource;
        const atsType = resolvedOfficial ? resolvedOfficial.atsType : item.boardSource;
        const atsTenant = resolvedOfficial ? resolvedOfficial.atsTenant : item.boardSource;
        const atsJob: AtsJob = {
          sourceJobId: item.sourceJobId,
          requisitionId: null,
          title: item.title,
          company: item.company,
          location: item.location,
          workplaceType: item.workplaceType,
          applyUrl: finalUrl,
          description: item.description,
          postedAt: item.postedAt,
          postedAtText: item.postedAtText,
        };
        const parsedDate = parseFirstSourceDate(
          [item.postedAt, item.postedAtText].filter((v): v is string | Date => v !== null),
          now,
        );
        try {
          const outcome = await upsertClassifiedAtsJob({
            job: atsJob,
            source,
            atsType,
            atsTenant,
            discoverySource: item.boardSource,
            sourceListingUrl: item.listingUrl,
            verificationProfile: isOfficial ? undefined : liveJobBoardProfile(item.boardSource),
            sourceDateProvenance: isOfficial
              ? employerAtsProvenance(parsedDate)
              : trustedRadarProvenance(parsedDate),
            classification: "QUALIFYING_INTERNSHIP",
            classificationReason: `Discovered live from ${SOURCE_LABELS[item.boardSource]}.`,
            now,
          });
          if (isOfficial) {
            await promoteCanonicalDirectJob(atsJob, source, atsTenant);
          }
          const bucket = stats.get(item.boardSource)!;
          if (outcome === "new") bucket.newCount += 1;
          else if (outcome === "updated") bucket.updatedCount += 1;
        } catch {
          // Keep per-job persistence errors non-fatal
        }
      }
    }),
  );

  return stats;
}

export async function runMultiSourceLiveCrawl(options: {
  maxPerSource?: number;
} = {}): Promise<MultiSourceCrawlSummary> {
  const startedAt = Date.now();
  const now = new Date();
  const maxPerSource = Math.max(10, Math.min(options.maxPerSource ?? 100, 300));

  const [liRes, indeedRes, handshakeRes, ilRes, directRes] = await Promise.all([
    crawlLinkedIn(now),
    crawlIndeed(now),
    crawlHandshake(now),
    crawlInternListDirect(now),
    crawlFastDirectAts(),
  ]);

  const rawBySource: Record<LiveCrawlerSourceId, { jobs: CrawledLiveJob[]; note?: string }> = {
    linkedin: { jobs: liRes.jobs.slice(0, maxPerSource), note: liRes.note },
    indeed: { jobs: indeedRes.jobs.slice(0, maxPerSource), note: indeedRes.note },
    handshake: { jobs: handshakeRes.jobs.slice(0, maxPerSource), note: handshakeRes.note },
    "intern-list": { jobs: ilRes.jobs.slice(0, maxPerSource), note: ilRes.note },
    "direct-ats": { jobs: directRes.jobs.slice(0, maxPerSource), note: directRes.note },
  };

  const allJobs = Object.values(rawBySource).flatMap((entry) => entry.jobs);
  const persistStats = await persistCrawledJobs(allJobs, now);

  const channels: MultiSourceChannelStatus[] = (
    ["linkedin", "indeed", "handshake", "intern-list", "direct-ats"] as LiveCrawlerSourceId[]
  ).map((source) => {
    const list = rawBySource[source].jobs;
    const freshUnder6h = list.filter((j) => j.postedAt && now.getTime() - j.postedAt.getTime() <= HOURS_6_MS).length;
    const freshUnder24h = list.filter((j) => j.postedAt && now.getTime() - j.postedAt.getTime() <= HOURS_24_MS).length;
    const counts = persistStats.get(source) ?? { newCount: 0, updatedCount: 0 };
    return {
      source,
      label: SOURCE_LABELS[source],
      fetched: list.length,
      freshUnder6h,
      freshUnder24h,
      persisted: counts.newCount,
      updated: counts.updatedCount,
      status: list.length > 0 ? "ok" : rawBySource[source].note ? "partial" : "unavailable",
      checkedAt: now.toISOString(),
      ...(rawBySource[source].note ? { note: rawBySource[source].note } : {}),
    };
  });

  await prisma.appSetting
    .upsert({
      where: { key: MULTI_SOURCE_STATUS_KEY },
      create: { key: MULTI_SOURCE_STATUS_KEY, value: JSON.stringify(channels) },
      update: { value: JSON.stringify(channels) },
    })
    .catch(() => undefined);

  return {
    durationMs: Date.now() - startedAt,
    totalFetched: allJobs.length,
    freshUnder6h: channels.reduce((sum, c) => sum + c.freshUnder6h, 0),
    freshUnder24h: channels.reduce((sum, c) => sum + c.freshUnder24h, 0),
    newCount: channels.reduce((sum, c) => sum + c.persisted, 0),
    updatedCount: channels.reduce((sum, c) => sum + c.updated, 0),
    channels,
  };
}

export async function getMultiSourceCrawlStatus(): Promise<MultiSourceChannelStatus[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: MULTI_SOURCE_STATUS_KEY } });
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? (parsed as MultiSourceChannelStatus[]) : [];
  } catch {
    return [];
  }
}
