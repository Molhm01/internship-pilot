// Eightfold AI ("PCSX") career sites.
//
// Eightfold career sites are fully client-rendered: fetching the HTML returns a
// shell with no postings in it, which is why employers on this vendor were
// previously reported as "no ATS config" even though their boards were public
// and healthy.
//
// The site's own front-end calls a public JSON API on the EMPLOYER'S careers
// host (not on eightfold.ai), observed live on 2026-08-22:
//
//   GET  https://<careersHost>/api/pcsx/search
//          ?domain=<groupId>&query=<terms>&location=&start=<n>&num=<n>
//        -> { status, data: { positions: [...], count } }
//
//   GET  https://<careersHost>/api/pcsx/position_details
//          ?position_id=<id>&domain=<groupId>&hl=en
//        -> { status, data: { positions: [ { jobDescription, ... } ] } }
//
// The tenant key is the value the page publishes as `window._EF_GROUP_ID`
// (for example "globalfoundries.com"). The vendor-hosted app.eightfold.ai
// mirror of the same API answers 403 "Not authorized for PCSX", so requests
// must go to the employer's own careers host with a matching Referer.
//
// `atsIdentifier` is stored as "<careersHost>|<groupId>".

import type { AtsJob } from "@/lib/ats/types";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SEARCH_TERMS = ["intern", "internship", "co-op"] as const;
const PAGE_SIZE = 25;
const PAGES_PER_TERM = 2;
const REQUEST_TIMEOUT_MS = 15_000;

export type EightfoldTenant = { careersHost: string; groupId: string };

/** Parse the stored "<careersHost>|<groupId>" identifier. */
export function parseEightfoldIdentifier(atsIdentifier: string): EightfoldTenant | null {
  const [careersHost, groupId] = atsIdentifier.split("|");
  if (!careersHost || !groupId) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(careersHost)) return null;
  return { careersHost: careersHost.toLowerCase(), groupId };
}

export function eightfoldJobUrl(tenant: EightfoldTenant, positionId: string | number): string {
  return `https://${tenant.careersHost}/careers/job/${positionId}`;
}

type EightfoldPosition = {
  id?: number | string;
  name?: string;
  locations?: unknown;
  postedTs?: number;
  creationTs?: number;
  atsJobId?: string;
  displayJobId?: string;
  positionUrl?: string;
  jobDescription?: string;
  workLocationOption?: string;
  // Eightfold's current Smart Apply pages server-render the same fields with
  // snake_case names inside <code id="smartApplyData">.
  t_create?: number;
  ats_job_id?: string;
  display_job_id?: string;
  canonicalPositionUrl?: string;
  job_description?: string;
  work_location_option?: string;
};

async function getJson(url: string, careersHost: string, throwOnFetchError = false): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        // The API is scoped to the employer's own site; without this it answers
        // 403 for the vendor-hosted mirror.
        Referer: `https://${careersHost}/careers`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (!throwOnFetchError) return null;
      throw Object.assign(new Error(`Eightfold returned HTTP ${response.status}.`), { code: `ATS_HTTP_${response.status}` });
    }
    return (await response.json()) as unknown;
  } catch (error) {
    if (!throwOnFetchError) return null;
    if (error && typeof error === "object" && "code" in error) throw error;
    throw Object.assign(new Error("Eightfold request failed."), { code: "ATS_NETWORK", cause: error });
  }
}

function positionsOf(payload: unknown): EightfoldPosition[] {
  const record = payload as { positions?: unknown; data?: { positions?: unknown } } | null;
  const positions = record?.data?.positions ?? record?.positions;
  return Array.isArray(positions) ? (positions as EightfoldPosition[]) : [];
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
}

/** Parse the public, server-rendered Smart Apply search payload. */
export function parseEightfoldSmartApplyJobs(
  html: string,
  tenant: EightfoldTenant,
  companyName: string,
): AtsJob[] {
  const block = html.match(/<code\b[^>]*\bid=["']smartApplyData["'][^>]*>([\s\S]*?)<\/code>/i)?.[1];
  if (!block) return [];
  try {
    const payload = JSON.parse(decodeHtml(block)) as unknown;
    return positionsOf(payload)
      .map((position) => toAtsJob(tenant, position, companyName))
      .filter((job): job is AtsJob => Boolean(job));
  } catch {
    return [];
  }
}

function firstLocation(value: unknown): string | null {
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === "string" && entry.trim());
    return typeof first === "string" ? first.trim() : null;
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function workplaceTypeOf(position: EightfoldPosition): string | null {
  const option = position.workLocationOption ?? position.work_location_option;
  if (typeof option !== "string") return null;
  if (/remote/i.test(option)) return "Remote";
  if (/hybrid/i.test(option)) return "Hybrid";
  if (/onsite|on-site/i.test(option)) return "On Site";
  return null;
}

function toAtsJob(
  tenant: EightfoldTenant,
  position: EightfoldPosition,
  companyName: string,
): AtsJob | null {
  if (position.id === undefined || position.id === null) return null;
  const title = typeof position.name === "string" ? position.name.trim() : "";
  if (!title) return null;

  let applyUrl = eightfoldJobUrl(tenant, position.id);
  const publishedUrl = position.positionUrl ?? position.canonicalPositionUrl;
  if (publishedUrl) {
    try {
      const candidate = new URL(publishedUrl, `https://${tenant.careersHost}`);
      if (candidate.hostname.toLowerCase() === tenant.careersHost) applyUrl = candidate.toString();
    } catch {
      // Keep the deterministic employer-hosted fallback URL.
    }
  }

  // postedTs is epoch SECONDS on this API.
  const postedAt =
    typeof (position.postedTs ?? position.t_create) === "number" && (position.postedTs ?? position.t_create)! > 0
      ? new Date((position.postedTs ?? position.t_create)! * 1000)
      : null;

  return {
    sourceJobId: String(position.id),
    requisitionId: position.atsJobId ?? position.ats_job_id ?? position.displayJobId ?? position.display_job_id ?? null,
    title,
    company: companyName,
    location: firstLocation(position.locations),
    workplaceType: workplaceTypeOf(position),
    applyUrl,
    description:
      typeof (position.jobDescription ?? position.job_description) === "string"
        ? (position.jobDescription ?? position.job_description)!
        : "",
    postedAt,
    postedAtText: null,
  };
}

/**
 * List internship-shaped postings on one Eightfold tenant.
 *
 * Vendor search does the narrowing — an Eightfold board can hold thousands of
 * postings, and paging through all of them to filter locally is exactly the
 * mistake that made large Workday tenants look empty.
 */
export async function listEightfoldJobs(
  atsIdentifier: string,
  companyName: string,
  options: { throwOnFetchError?: boolean; searchTerms?: string[] } = {},
): Promise<AtsJob[]> {
  const tenant = parseEightfoldIdentifier(atsIdentifier);
  if (!tenant) return [];

  const byId = new Map<string, AtsJob>();
  const terms = (options.searchTerms?.length ? options.searchTerms : [...SEARCH_TERMS])
    .map((term) => term.trim())
    .filter(Boolean);
  let legacyAvailable = true;

  for (const term of terms) {
    if (legacyAvailable) {
      try {
        for (let page = 0; page < PAGES_PER_TERM; page += 1) {
          const url =
            `https://${tenant.careersHost}/api/pcsx/search` +
            `?domain=${encodeURIComponent(tenant.groupId)}` +
            `&query=${encodeURIComponent(term)}` +
            `&location=&start=${page * PAGE_SIZE}&num=${PAGE_SIZE}&sort_by=relevance`;

          const positions = positionsOf(await getJson(url, tenant.careersHost, true));
          for (const position of positions) {
            const job = toAtsJob(tenant, position, companyName);
            if (job) byId.set(job.sourceJobId, job);
          }
          if (positions.length < PAGE_SIZE) break;
        }
      } catch {
        legacyAvailable = false;
      }
    }

    // Eightfold's current Smart Apply frontend server-renders search results
    // into smartApplyData. This URL shape is published by the page's own "View
    // All Jobs" and campaign links; it is a public page, not a guessed API.
    if (!legacyAvailable) {
      const searchUrl =
        `https://${tenant.careersHost}/careers` +
        `?query=${encodeURIComponent(term)}` +
        `&location=any&domain=${encodeURIComponent(tenant.groupId)}` +
        `&sort_by=relevance&triggerGoButton=true`;
      try {
        const response = await fetch(searchUrl, {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html,application/xhtml+xml",
            Referer: `https://${tenant.careersHost}/careers`,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`Eightfold Smart Apply returned HTTP ${response.status}.`);
        for (const job of parseEightfoldSmartApplyJobs(await response.text(), tenant, companyName)) {
          byId.set(job.sourceJobId, job);
        }
      } catch (error) {
        if (options.throwOnFetchError && byId.size === 0) {
          throw Object.assign(new Error("Eightfold Smart Apply request failed."), {
            code: "ATS_NETWORK",
            cause: error,
          });
        }
      }
    }
  }
  return [...byId.values()];
}

/**
 * Fetch the employer's real job description for one position.
 *
 * Kept separate from listing so a radar tick pays for exactly one description —
 * the posting it actually matched — instead of dozens it will discard.
 */
export async function fetchEightfoldJobDescription(
  atsIdentifier: string,
  positionId: string,
): Promise<string | null> {
  const tenant = parseEightfoldIdentifier(atsIdentifier);
  if (!tenant) return null;
  const url =
    `https://${tenant.careersHost}/api/pcsx/position_details` +
    `?position_id=${encodeURIComponent(positionId)}` +
    `&domain=${encodeURIComponent(tenant.groupId)}&hl=en`;
  const position = positionsOf(await getJson(url, tenant.careersHost))[0];
  const description = position?.jobDescription;
  return typeof description === "string" && description.trim() ? description : null;
}
