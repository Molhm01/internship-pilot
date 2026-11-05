import { createHash } from "node:crypto";
import type { AtsJob } from "@/lib/ats/types";

export type GenericScanResult = {
  jobs: AtsJob[];
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  notModified: boolean;
  // True when the fetched HTML is a substantive server-rendered page (or an
  // unchanged page we previously read). False on fetch failure and on JS
  // shells, so callers can refuse to report a false-success zero.
  pageReadable: boolean;
  // True only when the page shows an actual job-listing structure AND an
  // explicit empty result, i.e. a verified complete listing with genuinely
  // zero roles. A careers landing page without listing evidence is NOT
  // complete coverage, whatever its anchor count.
  completeEmptyListing: boolean;
};

function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Last-resort fallback for career pages with no known ATS (iCIMS/Taleo/
// SuccessFactors/fully custom sites vary too much to generalize reliably).
// This is intentionally low-confidence: it only looks for link text that
// reads like an internship, and every result it produces is routed straight
// to Quarantine/NeedsReview by the ingestion pipeline — never auto-verified.
//
// Supports conditional GETs (Milestone 4): if the site previously returned an
// ETag/Last-Modified and the page hasn't changed, the server replies 304 and
// we skip re-parsing entirely rather than re-fetching + re-scanning HTML on
// every check.
export async function scanCareersPageForInternshipLinks(
  careersUrl: string,
  companyName: string,
  conditional?: { etag?: string | null; lastModified?: string | null; contentHash?: string | null },
): Promise<GenericScanResult> {
  const empty: GenericScanResult = { jobs: [], etag: null, lastModified: null, contentHash: null, notModified: false, pageReadable: false, completeEmptyListing: false };

  let res: Response;
  try {
    res = await fetch(careersUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ...(conditional?.etag ? { "If-None-Match": conditional.etag } : {}),
        ...(conditional?.lastModified ? { "If-Modified-Since": conditional.lastModified } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return empty;
  }

  const etag = res.headers.get("etag");
  const lastModified = res.headers.get("last-modified");

  if (res.status === 304) {
    return {
      jobs: [],
      etag: etag ?? conditional?.etag ?? null,
      lastModified: lastModified ?? conditional?.lastModified ?? null,
      contentHash: conditional?.contentHash ?? null,
      notModified: true,
      pageReadable: true,
      completeEmptyListing: false,
    };
  }
  if (!res.ok) return empty;

  const html = await res.text();
  const contentHash = hashContent(html);
  // No ETag/Last-Modified support on this site, but the byte-identical page
  // as last time means nothing changed either — skip re-parsing exactly
  // like a 304 would, avoiding wasted work across hundreds of CSV-listed
  // career pages that don't support conditional requests.
  if (conditional?.contentHash && conditional.contentHash === contentHash) {
    return { jobs: [], etag, lastModified, contentHash, notModified: true, pageReadable: true, completeEmptyListing: false };
  }

  const jobs: AtsJob[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\s+[^>]*href="([^"]+)"[^>]*>([^<]{4,120})<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) && jobs.length < 40) {
    const [, href, textRaw] = match;
    const text = textRaw.replace(/\s+/g, " ").trim();
    if (!/intern|co-?op/i.test(text)) continue;
    if (seen.has(text)) continue;
    seen.add(text);

    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(href, careersUrl).toString();
    } catch {
      continue;
    }

    jobs.push({
      sourceJobId: absoluteUrl,
      requisitionId: null,
      title: text,
      company: companyName,
      location: null,
      workplaceType: null,
      applyUrl: absoluteUrl,
      description: `Found via a generic scan of ${careersUrl}. Not independently verified — confirm on the official careers page before trusting this listing.`,
      postedAt: null,
    });
  }
  // Readability needs content evidence, not anchor count alone: a JS shell
  // can render a full navigation bar. A shell pairs a framework mount point
  // with almost no server-rendered visible text.
  const visibleText = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const shellMarkers = /id=["'](root|app|__next)["']/i.test(html)
    || /__NEXT_DATA__|data-reactroot|ng-app|data-v-app/i.test(html);
  const shellLikely = jobs.length === 0 && shellMarkers && visibleText.length < 400;
  const pageReadable = jobs.length > 0 || !shellLikely && visibleText.length >= 400;

  // "Verified complete and empty" requires both a job-listing structure and
  // an explicit empty-state message. Anything else with zero matches is
  // unvalidated coverage, not a credible zero.
  const listingEvidence = /(job[-_ ]?(list|board|opening|position|posting|result)|career[-_ ]?(list|portal|site)|\/jobs?\/\d|requisition|req[-_ ]?id|search[-_ ]?results)/i.test(html);
  const emptyIndicator = /(no (current |available )?(openings|positions|jobs|results|vacancies)|0 (openings|positions|jobs|results)|nothing (was )?found|no matching (jobs|results|openings))/i.test(visibleText);
  const completeEmptyListing = jobs.length === 0 && listingEvidence && emptyIndicator;

  return { jobs, etag, lastModified, contentHash, notModified: false, pageReadable, completeEmptyListing };
}
