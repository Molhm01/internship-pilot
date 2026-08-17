import type { AtsJob } from "@/lib/ats/types";
import { isAggregatorUrl } from "@/lib/applications/officialDestination";

export type StructuredPortalKind = "icims" | "successfactors";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const STUDENT_ROLE_HINT = /\b(intern(?:ship)?s?|co-?ops?|undergrads?|undergraduates?|students?)\b/i;

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
}

export function stripPortalHtml(value: string): string {
  return decodeHtml(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = firstString(item);
      if (hit) return hit;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  return asString(record.value) ?? asString(record.name) ?? asString(record.identifier);
}

function findJobPosting(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 5) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findJobPosting(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  const record = asRecord(value);
  if (!record) return null;
  const rawType = record["@type"];
  const types = Array.isArray(rawType) ? rawType : [rawType];
  if (types.some((type) => typeof type === "string" && type.toLowerCase() === "jobposting")) {
    return record;
  }

  if (record["@graph"]) {
    const graphHit = findJobPosting(record["@graph"], depth + 1);
    if (graphHit) return graphHit;
  }

  for (const nested of Object.values(record)) {
    if (!nested || typeof nested !== "object") continue;
    const hit = findJobPosting(nested, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function extractJsonLdJobPosting(html: string): Record<string, unknown> | null {
  const scriptPattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html))) {
    const raw = decodeHtml(match[1].trim());
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const hit = findJobPosting(parsed);
      if (hit) return hit;
    } catch {
      // A malformed JSON-LD block should not poison the rest of the page.
    }
  }
  return null;
}

function metaContent(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta\\b[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]).trim() || null;
  }
  return null;
}

function headingTitle(html: string): string | null {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1?.[1]) {
    const value = stripPortalHtml(h1[1]);
    if (value) return value;
  }
  return metaContent(html, "og:title") ?? metaContent(html, "twitter:title");
}

function parseDate(value: unknown): Date | null {
  const text = asString(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function locationFromAddress(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const address = asRecord(record.address) ?? record;
  const parts = [
    asString(address.addressLocality),
    asString(address.addressRegion),
    asString(address.addressCountry),
    asString(address.postalCode),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : null;
}

function formatJobLocation(value: unknown): string | null {
  const locations = Array.isArray(value) ? value : [value];
  const formatted = locations
    .map(locationFromAddress)
    .filter((location): location is string => Boolean(location));
  return formatted.length > 0 ? [...new Set(formatted)].join("; ") : null;
}

function sourceJobIdFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const icims = parsed.pathname.match(/\/jobs\/(\d+)/i);
    if (icims) return icims[1];
    const successFactorsQuery = parsed.searchParams.get("career_job_req_id");
    if (successFactorsQuery) return successFactorsQuery;
    const pathId = parsed.pathname.match(/\/(\d+)\/?$/);
    if (pathId) return pathId[1];
  } catch {
    // Fall through to the stable URL itself.
  }
  return url;
}

export function parseStructuredJobPage(
  html: string,
  pageUrl: string,
  companyName: string,
  fallbackTitle: string | null = null,
): AtsJob | null {
  const posting = extractJsonLdJobPosting(html);
  const title =
    asString(posting?.title)
    ?? asString(posting?.name)
    ?? headingTitle(html)
    ?? fallbackTitle;
  if (!title) return null;

  const description = posting?.description
    ? stripPortalHtml(String(posting.description))
    : stripPortalHtml(metaContent(html, "description") ?? "");

  const identifier = firstString(posting?.identifier);
  const structuredUrl = asString(posting?.url);
  const employmentTypeRaw = posting?.employmentType;
  const employmentType = Array.isArray(employmentTypeRaw)
    ? employmentTypeRaw.filter((item): item is string => typeof item === "string").join(", ") || null
    : asString(employmentTypeRaw);
  const jobLocationType = asString(posting?.jobLocationType);
  const location = formatJobLocation(posting?.jobLocation);

  return {
    sourceJobId: identifier ?? sourceJobIdFromUrl(pageUrl),
    requisitionId: identifier,
    title: stripPortalHtml(title),
    company: companyName,
    location,
    workplaceType: /telecommute|remote/i.test(jobLocationType ?? "") ? "Remote" : null,
    applyUrl: structuredUrl && !isAggregatorUrl(structuredUrl) ? structuredUrl : pageUrl,
    description,
    postedAt: parseDate(posting?.datePosted),
    employmentType,
  };
}

type PortalLink = { url: string; text: string };

function anchorLinks(html: string, baseUrl: string): PortalLink[] {
  const out: PortalLink[] = [];
  const seen = new Set<string>();
  const pattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    let url: string;
    try {
      url = new URL(decodeHtml(match[1]), baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(url) || isAggregatorUrl(url)) continue;
    seen.add(url);
    out.push({ url, text: stripPortalHtml(match[2]) });
  }
  return out;
}

function isIcimsDetailUrl(url: URL): boolean {
  if (!url.hostname.toLowerCase().endsWith(".icims.com")) return false;
  return /\/jobs\/\d+(?:\/|$)/i.test(url.pathname) || /\/careers-home\/jobs\/\d+(?:\/|$)/i.test(url.pathname);
}

function isSuccessFactorsDetailUrl(url: URL): boolean {
  if (/\/job\/[^?#]+\/\d+\/?$/i.test(url.pathname)) return true;
  return (
    url.searchParams.get("career_ns")?.toLowerCase() === "job_listing"
    && Boolean(url.searchParams.get("career_job_req_id"))
  );
}

function isDetailUrl(kind: StructuredPortalKind, rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return kind === "icims" ? isIcimsDetailUrl(url) : isSuccessFactorsDetailUrl(url);
  } catch {
    return false;
  }
}

function hostLooksLikeAts(kind: StructuredPortalKind, hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (kind === "icims") return host.endsWith(".icims.com");
  return host.includes("successfactors.");
}

function looksLikePortalNavigation(kind: StructuredPortalKind, link: PortalLink, base: URL): boolean {
  let url: URL;
  try {
    url = new URL(link.url);
  } catch {
    return false;
  }

  const sameHost = url.hostname === base.hostname;
  const atsHost = hostLooksLikeAts(kind, url.hostname);
  if (!sameHost && !atsHost) return false;

  const signal = `${url.pathname} ${url.search} ${link.text}`;
  if (kind === "icims") {
    return /\/jobs(?:\/search)?\b|\b(search|view|open)\s+jobs?\b|[?&](?:pr|page)=\d+/i.test(signal);
  }
  return /\/job\b|\/jobs\b|\/search\b|\/go\b|\b(search|view|open)\s+jobs?\b|career_ns=job_listing_summary|[?&](?:page|startrow)=\d+/i.test(signal);
}

async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/html|xhtml|text/i.test(contentType)) return null;
    return { html: await response.text(), finalUrl: response.url || url };
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

function allowedDetailHost(kind: StructuredPortalKind, detailUrl: URL, allowedHosts: Set<string>): boolean {
  if (allowedHosts.has(detailUrl.hostname)) return true;
  return hostLooksLikeAts(kind, detailUrl.hostname);
}

export async function crawlStructuredPortalJobs(options: {
  kind: StructuredPortalKind;
  companyName: string;
  careersUrl: string;
  additionalStartUrls?: string[];
  maxListPages?: number;
  maxJobDetails?: number;
}): Promise<AtsJob[]> {
  const maxListPages = Math.max(1, Math.min(options.maxListPages ?? 6, 10));
  const maxJobDetails = Math.max(1, Math.min(options.maxJobDetails ?? 35, 60));
  const queue = [options.careersUrl, ...(options.additionalStartUrls ?? [])];
  const queued = new Set(queue);
  const visited = new Set<string>();
  const allowedHosts = new Set<string>();
  const details = new Map<string, string>();

  while (queue.length > 0 && visited.size < maxListPages) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const page = await fetchHtml(current);
    if (!page) continue;

    let base: URL;
    try {
      base = new URL(page.finalUrl);
      allowedHosts.add(base.hostname);
    } catch {
      continue;
    }

    for (const link of anchorLinks(page.html, page.finalUrl)) {
      if (isDetailUrl(options.kind, link.url)) {
        const hint = `${link.text} ${link.url}`;
        if (STUDENT_ROLE_HINT.test(hint) && !details.has(link.url)) {
          details.set(link.url, link.text);
        }
        continue;
      }

      if (looksLikePortalNavigation(options.kind, link, base) && !queued.has(link.url)) {
        queued.add(link.url);
        queue.push(link.url);
      }
    }
  }

  const detailEntries = [...details.entries()].slice(0, maxJobDetails);
  const parsed = await mapWithConcurrency(detailEntries, 5, async ([url, fallbackTitle]) => {
    const page = await fetchHtml(url);
    if (!page) return null;

    let finalUrl: URL;
    try {
      finalUrl = new URL(page.finalUrl);
    } catch {
      return null;
    }
    if (!allowedDetailHost(options.kind, finalUrl, allowedHosts) || isAggregatorUrl(finalUrl.toString())) {
      return null;
    }

    const job = parseStructuredJobPage(page.html, finalUrl.toString(), options.companyName, fallbackTitle || null);
    if (!job || !STUDENT_ROLE_HINT.test(job.title)) return null;

    try {
      const apply = new URL(job.applyUrl, finalUrl);
      if (!allowedDetailHost(options.kind, apply, allowedHosts) || isAggregatorUrl(apply.toString())) {
        job.applyUrl = finalUrl.toString();
      } else {
        job.applyUrl = apply.toString();
      }
    } catch {
      job.applyUrl = finalUrl.toString();
    }
    return job;
  });

  const jobs: AtsJob[] = [];
  const seen = new Set<string>();
  for (const job of parsed) {
    if (!job) continue;
    const key = `${job.sourceJobId}|${job.applyUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push(job);
  }
  return jobs;
}
