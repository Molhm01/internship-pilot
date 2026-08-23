// Second-level discovery for career pages that render their jobs in the browser.
//
// "The HTML contained no job links" is not the same as "this employer has no
// jobs". Modern career sites ship an empty shell and fill it from JSON, and the
// data is very often still reachable without a browser — embedded in the page,
// or behind a JSON endpoint the page names in plain sight.
//
// This module looks, in order, for:
//
//   1. schema.org JobPosting JSON-LD (the most standardised, and it carries a
//      canonical `url` plus a real `description`)
//   2. Next.js `__NEXT_DATA__` and other embedded state blobs (Apollo,
//      Redux/`__INITIAL_STATE__`, `__NUXT__`)
//   3. an ATS board embedded as an iframe or script widget
//
// Everything here is pure parsing over HTML a caller already fetched, so it is
// cheap, fully testable from fixtures, and never launches a browser.

import type { AtsJob } from "@/lib/ats/types";
import { detectAtsFromText, type AtsDetectionResult } from "@/lib/ats/detect";
import { extractOfficialJobLinks } from "@/lib/ats/employerPageLinks";

export type SpaDiscovery = {
  /** Postings recovered directly from the page's own embedded data. */
  jobs: AtsJob[];
  /** A classic ATS board the page embeds rather than links. */
  embeddedAts: AtsDetectionResult | null;
  /** JSON endpoints the page references, worth a follow-up fetch. */
  apiHints: string[];
  /** Count of anchors on the page that already ARE official job URLs. */
  officialJobLinks: number;
};

export const EMPTY_SPA_DISCOVERY: SpaDiscovery = {
  jobs: [],
  embeddedAts: null,
  apiHints: [],
  officialJobLinks: 0,
};

const MAX_JOBS = 60;
const MAX_API_HINTS = 6;

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stripHtml(value: string): string {
  return (
    value
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      // Inline tags leave a space before the punctuation that followed them
      // ("<b>fixtures</b>." becomes "fixtures ."). The ATS scorer reads this
      // text, so it should read like prose.
      .replace(/\s+([,.;:!?)\]])/g, "$1")
      .replace(/([([])\s+/g, "$1")
      .trim()
  );
}

function parseDate(value: unknown): Date | null {
  const text = textOf(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Flatten schema.org location shapes into one human string. */
function jobPostingLocation(node: Record<string, unknown>): string | null {
  const raw = node.jobLocation;
  const entries = Array.isArray(raw) ? raw : [raw];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const address = (entry as Record<string, unknown>).address;
    if (typeof address === "string") return address;
    if (address && typeof address === "object") {
      const a = address as Record<string, unknown>;
      const parts = [a.addressLocality, a.addressRegion, a.addressCountry]
        .map((part) => (typeof part === "string" ? part : null))
        .filter(Boolean);
      if (parts.length > 0) return parts.join(", ");
    }
  }
  if (node.jobLocationType === "TELECOMMUTE") return "Remote";
  return null;
}

function jobPostingToAtsJob(
  node: Record<string, unknown>,
  pageUrl: string,
  companyName: string,
): AtsJob | null {
  const title = textOf(node.title);
  if (!title) return null;

  const rawUrl = textOf(node.url) ?? textOf((node.mainEntityOfPage as Record<string, unknown>)?.["@id"]);
  let applyUrl: string;
  try {
    applyUrl = new URL(rawUrl ?? pageUrl, pageUrl).toString();
  } catch {
    return null;
  }

  const identifier = node.identifier;
  const requisitionId =
    textOf(identifier) ??
    (identifier && typeof identifier === "object"
      ? textOf((identifier as Record<string, unknown>).value)
      : null);

  const description = textOf(node.description);

  return {
    sourceJobId: requisitionId ?? applyUrl,
    requisitionId,
    title,
    company: textOf((node.hiringOrganization as Record<string, unknown>)?.name) ?? companyName,
    location: jobPostingLocation(node),
    workplaceType: node.jobLocationType === "TELECOMMUTE" ? "Remote" : null,
    applyUrl,
    description: description ? stripHtml(description) : "",
    postedAt: parseDate(node.datePosted),
    postedAtText: null,
    employmentType: textOf(node.employmentType),
  };
}

function collectJobPostings(node: unknown, out: Record<string, unknown>[]): void {
  if (out.length >= MAX_JOBS) return;
  if (Array.isArray(node)) {
    for (const entry of node) collectJobPostings(entry, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const type = record["@type"];
  const isJobPosting = Array.isArray(type)
    ? type.some((t) => t === "JobPosting")
    : type === "JobPosting";
  if (isJobPosting) {
    out.push(record);
    return;
  }
  for (const value of Object.values(record)) collectJobPostings(value, out);
}

/** schema.org JobPosting blocks embedded in the page. */
export function parseJsonLdJobPostings(
  html: string,
  pageUrl: string,
  companyName: string,
): AtsJob[] {
  const found: Record<string, unknown>[] = [];
  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      collectJobPostings(JSON.parse(raw), found);
    } catch {
      // A single malformed block must not discard the rest of the page.
    }
  }
  const jobs: AtsJob[] = [];
  for (const node of found) {
    const job = jobPostingToAtsJob(node, pageUrl, companyName);
    if (job) jobs.push(job);
  }
  return jobs;
}

const STATE_BLOB_PATTERNS = [
  /<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  /window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
  /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
  /window\.__NUXT__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
  /window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
] as const;

/**
 * Postings hiding in an embedded state blob.
 *
 * These blobs have no shared schema, so rather than guess at each framework's
 * shape we look for objects that carry a job-shaped set of fields.
 */
export function parseEmbeddedStateJobs(
  html: string,
  pageUrl: string,
  companyName: string,
): AtsJob[] {
  const jobs: AtsJob[] = [];
  const seen = new Set<string>();

  for (const pattern of STATE_BLOB_PATTERNS) {
    const raw = html.match(pattern)?.[1];
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const walk = (node: unknown): void => {
      if (jobs.length >= MAX_JOBS) return;
      if (Array.isArray(node)) {
        for (const entry of node) walk(entry);
        return;
      }
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;

      const title = textOf(record.title) ?? textOf(record.name) ?? textOf(record.jobTitle);
      const link =
        textOf(record.applyUrl) ??
        textOf(record.absolute_url) ??
        textOf(record.jobUrl) ??
        textOf(record.url) ??
        textOf(record.canonicalUrl) ??
        textOf(record.positionUrl);
      if (title && link && /intern|co-?op/i.test(title)) {
        let applyUrl: string | null = null;
        try {
          applyUrl = new URL(link, pageUrl).toString();
        } catch {
          applyUrl = null;
        }
        if (applyUrl && !seen.has(applyUrl)) {
          seen.add(applyUrl);
          jobs.push({
            sourceJobId:
              textOf(record.id) ?? textOf(record.jobId) ?? textOf(record.requisitionId) ?? applyUrl,
            requisitionId: textOf(record.requisitionId) ?? textOf(record.reqId) ?? null,
            title,
            company: companyName,
            location:
              textOf(record.location) ??
              textOf(record.locationName) ??
              textOf(record.city) ??
              null,
            workplaceType: null,
            applyUrl,
            description: textOf(record.description) ? stripHtml(String(record.description)) : "",
            postedAt: parseDate(record.postedAt ?? record.datePosted ?? record.publishedAt),
            postedAtText: textOf(record.postedOn) ?? null,
          });
          return;
        }
      }

      for (const value of Object.values(record)) walk(value);
    };

    walk(parsed);
  }
  return jobs;
}

/** JSON endpoints the page itself names — candidates for a follow-up fetch. */
export function extractApiHints(html: string, pageUrl: string): string[] {
  const hints: string[] = [];
  const seen = new Set<string>();
  // The path stops at a quote OR a "?" so an endpoint written with its query
  // string inline ("/api/jobs/search?q=") is still recognised.
  const patterns = [
    /["'`](\/(?:api|widgets|services|rest)\/[a-z0-9._/-]*(?:job|search|position|opening|career)[a-z0-9._/-]*)(?=["'`?])/gi,
    /["'`](https?:\/\/[a-z0-9.-]+\/(?:api|widgets|services)\/[a-z0-9._/-]*(?:job|search|position)[a-z0-9._/-]*)(?=["'`?])/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const raw = match[1];
      if (!raw) continue;
      let absolute: string;
      try {
        absolute = new URL(raw, pageUrl).toString();
      } catch {
        continue;
      }
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      hints.push(absolute);
      if (hints.length >= MAX_API_HINTS) return hints;
    }
  }
  return hints;
}

/**
 * An ATS board the page EMBEDS (iframe/script src) rather than links to.
 *
 * detectAtsFromText already scans whole bodies, but a page can mention a vendor
 * in tracking or boilerplate; restricting to iframe/script sources is stronger
 * evidence that the board is the page's actual job content.
 */
export function detectEmbeddedAtsBoard(html: string): AtsDetectionResult | null {
  for (const match of html.matchAll(
    /<(?:iframe|script)\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi,
  )) {
    const src = match[1];
    if (!src) continue;
    const detected = detectAtsFromText(src);
    if (detected.atsType !== "unknown" && detected.atsIdentifier) return detected;
  }
  return null;
}

/**
 * Fetch a careers page and read whatever postings it embeds.
 *
 * Used by the "spa" adapter path: `atsIdentifier` for that path is the careers
 * URL itself, because there is no vendor tenant to name.
 */
export async function listSpaEmbeddedJobs(
  careersUrl: string,
  companyName: string,
): Promise<AtsJob[]> {
  try {
    const response = await fetch(careersUrl, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return [];
    const html = await response.text();
    return discoverFromRenderedShell(html, response.url || careersUrl, companyName).jobs;
  } catch {
    return [];
  }
}

/** Run every no-browser strategy over one already-fetched careers page. */
export function discoverFromRenderedShell(
  html: string,
  pageUrl: string,
  companyName: string,
): SpaDiscovery {
  const jsonLd = parseJsonLdJobPostings(html, pageUrl, companyName);
  const embedded = jsonLd.length > 0 ? jsonLd : parseEmbeddedStateJobs(html, pageUrl, companyName);
  return {
    jobs: embedded,
    embeddedAts: detectEmbeddedAtsBoard(html),
    apiHints: extractApiHints(html, pageUrl),
    officialJobLinks: extractOfficialJobLinks(html, pageUrl, companyName).length,
  };
}
