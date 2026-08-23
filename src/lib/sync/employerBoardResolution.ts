// Automatic employer → official job board resolution.
//
// A fresh internship must not disappear because its employer is absent from
// the approved-employer CSV. That CSV holds ~497 companies; a single fresh
// engineering sweep of a public feed routinely names 48 distinct employers of
// which ~10 are on it. Matching only against the CSV therefore throws away
// roughly four out of five legitimate fresh internships before any network
// call is even made.
//
// So this module resolves employers the CSV has never heard of:
//
//   normalized company name
//     → an existing approved Company row, if there is one (cheapest, strongest)
//     → otherwise the domain THE SOURCE PUBLISHED for that company
//     → that domain's own careers page
//     → the ATS tenant that page itself links to (or a conservative board probe)
//
// Two rules keep this honest:
//   1. Domains are never invented. Only a domain a source stated is crawled.
//   2. A tenant is only accepted on evidence — the employer's own page links to
//      it, or a board probe returned postings under a slug derived from that
//      employer's own name/domain. This is the same bar ApprovedAtsTenant uses.
//
// Results are cached in EmployerBoardResolution, positives and negatives alike,
// because the fresh radar runs every few minutes and must never re-crawl the
// same employer on every tick.

import { prisma } from "@/lib/db";
import type { CompanyForListing } from "@/lib/ats";
import {
  detectAtsForCareersPage,
  detectAtsFromText,
  detectClientRenderedAts,
} from "@/lib/ats/detect";
import { renderCareersPage } from "@/lib/ats/headlessResolver";
import {
  oracleRecruitingCloudBoardName,
  parseOracleRecruitingCloudIdentifier,
} from "@/lib/ats/oracleRecruitingCloud";
import { parsePaylocityIdentifier } from "@/lib/ats/paylocity";
import { boardNameMatchesCompany, resolveAtsForCompany } from "@/lib/ats/resolve";
import {
  discoverFromRenderedShell,
  type SpaDiscovery,
} from "@/lib/ats/spaDiscovery";
import {
  normalizeCompanyKey,
  type FreshSignalReason,
} from "@/lib/sync/freshSignalReasons";

export type EmployerBoardConfig = CompanyForListing & {
  /** Where the config came from, for diagnostics and audit. */
  origin: "approved_company" | "cached_resolution" | "discovered";
};

export type EmployerBoardOutcome =
  | { ok: true; config: EmployerBoardConfig }
  | { ok: false; reason: Extract<FreshSignalReason, "UNKNOWN_COMPANY" | "NO_ATS_CONFIG" | "BOARD_WRONG_EMPLOYER"> };

const ONE_HOUR_MS = 60 * 60 * 1000;
/** How long a successful board resolution is reused before being re-proved. */
const RESOLVED_TTL_MS = 7 * 24 * ONE_HOUR_MS;
/** Backoff ceiling for employers we could not resolve. */
const MAX_NEGATIVE_BACKOFF_MS = 14 * 24 * ONE_HOUR_MS;
const RESOLUTION_STRATEGY_VERSION = "approved-careers-page-v1";

/** Careers paths to try, in descending order of how conventional they are. */
const CAREERS_PATHS = [
  "/careers",
  "/careers/jobs",
  "/jobs",
  "/company/careers",
  "/about/careers",
  "/en/careers",
  "/",
] as const;

/**
 * Hosts to try for one employer, strongest first.
 *
 * Sources very often publish a COUNTRY SITE as the company's website —
 * "usa.philips.com", "us.pg.com", "us.specialisterne.com" — while the careers
 * site lives on the registrable domain. Adding the apex is not inventing a
 * domain: it is the same registrable domain the source already named, with a
 * regional prefix removed.
 *
 * Deliberately does not strip arbitrary subdomains: only a leading region-ish
 * label, and only down to a two-label apex.
 */
export function hostCandidates(domain: string): string[] {
  const host = domain.toLowerCase().replace(/^www\./, "");
  const labels = host.split(".");
  if (labels.length <= 2) return [host];

  const apex = labels.slice(-2).join(".");
  // A multi-part public suffix (co.uk, com.au) would make a two-label "apex"
  // meaningless, so require the apex to have a plausible single-label TLD.
  if (labels.at(-2)!.length <= 3 && labels.length >= 3) {
    const wider = labels.slice(-3).join(".");
    return host === wider ? [host] : [host, wider];
  }
  return host === apex ? [host] : [host, apex];
}

/**
 * The employer's own careers HOST, when it publishes one.
 *
 * Large employers overwhelmingly serve their careers site from a dedicated
 * subdomain rather than a path — careers.newyorklife.com, jobs.grainger.com,
 * careers.mayoclinic.org — and those hosts sit directly on the vendor. The
 * path cascade never reaches them, and the homepage-link pass only does when
 * the corporate homepage is both fetchable and server-renders its navigation,
 * which for exactly these employers it often is not.
 *
 * A live diagnostic over 60 fresh signals found three employers (New York Life,
 * Grainger, Mayo Clinic) whose readable SuccessFactors/Eightfold board was
 * sitting on such a host while the pipeline recorded NO_ATS_CONFIG.
 *
 * This is not a guess at a domain: it is the standard careers subdomain of the
 * registrable domain the SOURCE already published for this employer, and it is
 * only ever accepted when the page it serves carries a real vendor signature.
 * Deliberately root-only — two extra requests per employer, not fourteen.
 */
export function careersHostUrls(domain: string): string[] {
  const urls: string[] = [];
  for (const base of hostCandidates(domain)) {
    if (/^(careers|jobs)\./i.test(base)) continue;
    for (const prefix of ["careers", "jobs"]) urls.push(`https://${prefix}.${base}/`);
  }
  return [...new Set(urls)];
}

/**
 * Vendors whose identifier IS the employer's own tenant slug.
 *
 * Only these can be checked for employer agreement. A SuccessFactors
 * identifier is a shared portal host ("performancemanager8"), an Eightfold one
 * is "<host>|<groupId>", and an spa/employer-page one is a URL — none of them
 * says anything about which company owns the board, so demanding agreement
 * there would reject correct configurations.
 */
const BOARD_PROBE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const TENANT_SLUG_VENDORS = new Set(["greenhouse", "lever", "ashby", "smartrecruiters"]);

function alphanumeric(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Does this board plausibly belong to this employer?
 *
 * A careers page links to plenty of boards that are not the employer's own:
 * portfolio companies, partners, embedded third-party job widgets. The live
 * diagnostic caught exactly that — "Cubit Capital" was configured against
 * `greenhouse/trueanomalyinc` because True Anomaly's board was linked from
 * cubit.capital. Nothing false reached the catalogue only because the title
 * matcher happened to reject every posting, which is luck rather than a
 * guarantee: a Greenhouse board carrying an "Electrical Engineer Intern" would
 * have been published under the wrong employer with a wrong Apply URL.
 *
 * Accepts on name/domain agreement so no legitimate configuration is lost.
 */
export function slugLooksLikeEmployer(
  slug: string,
  companyName: string,
  domain: string | null,
): boolean {
  const normalizedSlug = alphanumeric(slug);
  if (!normalizedSlug) return false;

  const candidates = new Set<string>();
  const company = alphanumeric(companyName);
  if (company) candidates.add(company);
  for (const token of companyName.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length >= 4) candidates.add(token);
  }
  if (domain) {
    for (const label of domain.toLowerCase().split(".")) {
      if (label.length >= 3 && label !== "www" && label !== "com") candidates.add(label);
    }
  }

  for (const candidate of candidates) {
    if (normalizedSlug.includes(candidate) || candidate.includes(normalizedSlug)) return true;
  }
  return false;
}

function negativeBackoffMs(attempts: number): number {
  return Math.min(MAX_NEGATIVE_BACKOFF_MS, 6 * ONE_HOUR_MS * 2 ** Math.max(0, attempts - 1));
}

function usableAts(atsType: string | null | undefined): boolean {
  return Boolean(atsType) && atsType !== "unknown" && atsType !== "custom";
}

/**
 * Can listJobsForCompany actually read this board with what we have?
 *
 * SuccessFactors is driven entirely by the careers URL, so it needs no tenant
 * identifier; everything else does.
 */
function isReadableBoard(atsType: string, atsIdentifier: string | null): boolean {
  if (atsType === "successfactors") return true;
  if (!atsIdentifier) return false;
  return [
    "greenhouse",
    "lever",
    "ashby",
    "smartrecruiters",
    "workable",
    "workday",
    // Employer-operated public search APIs, observed from the employer's own
    // page rather than guessed. Their identifier is the employer, not a tenant.
    "ibm-careers",
    "bytedance-careers",
    "oracle-recruiting-cloud",
    "paylocity",
    "icims",
    "taleo",
    // Client-rendered career-site vendors. Their identifier is
    // "<careersHost>|<tenantKey>" and their postings come from a public JSON
    // API on the employer's own host.
    "eightfold",
    "phenom",
    // Not vendors: page-derived paths whose "identifier" is a URL.
    "spa",
    "employer-page",
  ].includes(atsType);
}

/**
 * A provider stated directly by an approved employer's published careers URL.
 *
 * This evidence is stronger than a cached generic page scan. IBM's approved
 * URL is `ibm.com/careers`, which unambiguously routes to IBM's observed public
 * search adapter; an older rendered scan had cached one unrelated Taiwan link
 * as an `employer-page` and otherwise hid the real board for seven days.
 */
export function providerConfigFromPublishedCareersUrl(
  company: CompanyForListing,
): EmployerBoardConfig | null {
  if (!company.careersUrl) return null;
  const detected = detectAtsFromText(company.careersUrl);
  if (!isReadableBoard(detected.atsType, detected.atsIdentifier)) return null;
  return {
    ...company,
    atsType: detected.atsType,
    atsIdentifier: detected.atsIdentifier ?? detected.atsType,
    origin: "approved_company",
  };
}

/**
 * Inspect the exact approved careers page before deriving generic paths from
 * its domain. Paths can be case-sensitive: Marathon publishes `/Jobs/`, whose
 * HTML links its Workday board, while a derived lowercase `/jobs` returns a
 * different answer. The exact employer-approved URL is the strongest starting
 * evidence available.
 */
export async function discoverProviderFromPublishedCareersPage(
  company: CompanyForListing,
  domain: string | null,
): Promise<EmployerBoardConfig | null> {
  const direct = providerConfigFromPublishedCareersUrl(company);
  if (direct) return direct;
  if (!company.careersUrl) return null;
  let detected = await detectAtsForCareersPage(company.careersUrl);
  if (!isReadableBoard(detected.atsType, detected.atsIdentifier)) {
    const rendered = await renderCareersPage(company.careersUrl);
    if (rendered) {
      const fromUrl = detectAtsFromText(rendered.finalUrl);
      const linked = detectAtsFromText(rendered.html);
      const clientRendered = detectClientRenderedAts(rendered.html, rendered.finalUrl);
      detected = isReadableBoard(fromUrl.atsType, fromUrl.atsIdentifier)
        ? fromUrl
        : isReadableBoard(linked.atsType, linked.atsIdentifier)
          ? linked
          : clientRendered;
    }
  }
  if (!isReadableBoard(detected.atsType, detected.atsIdentifier)) return null;
  if (!(await boardBelongsToEmployer(detected.atsType, detected.atsIdentifier, company.name, domain))) {
    return null;
  }
  return {
    ...company,
    atsType: detected.atsType,
    atsIdentifier: detected.atsIdentifier ?? detected.atsType,
    origin: "approved_company",
  };
}

/**
 * Load every approved company once per radar tick and index it by normalized
 * name. Doing this per signal would be hundreds of identical queries.
 */
export async function loadApprovedCompanyIndex(): Promise<Map<string, CompanyForListing>> {
  const companies = await prisma.company.findMany({
    where: { allowlisted: true, monitoringStatus: "active" },
    select: {
      name: true,
      atsType: true,
      atsIdentifier: true,
      careersUrl: true,
    },
  });
  const index = new Map<string, CompanyForListing>();
  for (const company of companies) {
    index.set(normalizeCompanyKey(company.name), {
      ...company,
      lastETag: null,
      lastModified: null,
      contentHash: null,
    });
  }
  return index;
}

/**
 * Approved-company lookup: exact normalized key first, then a containment match
 * for names long enough that containment cannot be a coincidence.
 */
export function findApprovedCompany(
  companyName: string,
  index: Map<string, CompanyForListing>,
): CompanyForListing | null {
  const key = normalizeCompanyKey(companyName);
  if (!key) return null;
  const exact = index.get(key);
  if (exact) return exact;
  if (key.length < 6) return null;
  for (const [candidateKey, company] of index) {
    if (candidateKey.length < 6) continue;
    if (candidateKey.includes(key) || key.includes(candidateKey)) return company;
  }
  return null;
}

const CAREERS_LINK_TEXT = /\b(careers?|jobs|join\s+(us|our\s+team)|work\s+(with|for)\s+us|open\s+(roles|positions))\b/i;
const MAX_HOMEPAGE_CAREERS_LINKS = 6;

/**
 * Careers destinations the employer's own homepage links to.
 *
 * Deliberately allows a different hostname: an employer that publishes its
 * careers site at careers.example.com or examplecareers.com has still stated
 * that destination itself. What is never allowed is a hostname nobody stated.
 */
/**
 * How likely a careers link is to be the actual jobs ENTRY POINT.
 *
 * Lower sorts first. This ranking exists because a corporate homepage links to
 * a dozen careers-flavoured marketing pages, and taking the first few in
 * document order is how "gf.com" ended up crawling
 * /careers/where-we-work/north-america/ and never reaching careers.gf.com —
 * the Eightfold site that actually holds the jobs.
 */
function careersLinkRank(url: URL, homepageHost: string): number {
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const path = url.pathname.replace(/\/+$/, "").toLowerCase();
  const depth = path.split("/").filter(Boolean).length;

  // A dedicated careers host (careers.acme.com, jobs.acme.com, acmecareers.com)
  // is the strongest signal an employer can give about where its jobs live.
  const dedicatedHost = host !== homepageHost && /(^|\.)(careers?|jobs)\.|careers?$|jobs$/.test(host);
  if (dedicatedHost) return depth === 0 ? 0 : 1;

  // A top-level /careers or /jobs on the same site.
  if (depth <= 1 && /^\/(careers?|jobs)$/.test(path || "/")) return 2;
  if (depth <= 2 && /^\/(careers?|jobs)\//.test(path)) return 3;
  if (host !== homepageHost) return 4;
  return 5 + depth;
}

export function extractCareersLinks(html: string, homepageUrl: string): string[] {
  const candidates: { url: URL; rank: number }[] = [];
  const seen = new Set<string>();
  let homepageHost = "";
  try {
    homepageHost = new URL(homepageUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return [];
  }

  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const href = match[1];
    const text = (match[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!href) continue;
    if (!CAREERS_LINK_TEXT.test(text) && !CAREERS_LINK_TEXT.test(href)) continue;

    let url: URL;
    try {
      url = new URL(href, homepageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const normalized = `https://${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push({ url, rank: careersLinkRank(url, homepageHost) });
  }

  return candidates
    .sort((a, b) => a.rank - b.rank || a.url.pathname.length - b.url.pathname.length)
    .slice(0, MAX_HOMEPAGE_CAREERS_LINKS)
    .map((candidate) => candidate.url.toString());
}

/** Fetch one page and run the no-browser embedded-data strategies over it. */
async function fetchRenderedShell(
  careersUrl: string,
  companyName: string,
): Promise<SpaDiscovery | null> {
  try {
    const response = await fetch(careersUrl, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const html = await response.text();
    return discoverFromRenderedShell(html, response.url || careersUrl, companyName);
  } catch {
    return null;
  }
}

/**
 * Dedicated careers hosts a page REFERENCES, even outside an anchor.
 *
 * GlobalFoundries is the case that motivated this: gf.com's homepage links only
 * to marketing pages under /careers/, and the actual Eightfold site
 * (careers.gf.com) is referenced from inside those pages — in a script config,
 * not an <a href>. Scanning for careers-shaped hostnames finds it. This is
 * still a host the employer's own page names; nothing is constructed.
 */
export function dedicatedCareersHostUrls(html: string, baseUrl: string): string[] {
  let baseHost = "";
  try {
    baseHost = new URL(baseUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return [];
  }
  const registrable = baseHost.split(".").slice(-2).join(".");

  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const host = match[1]!.toLowerCase().replace(/^www\./, "");
    if (host === baseHost || seen.has(host)) continue;
    const isCareersHost =
      /^(careers?|jobs|recruiting|talent)\./.test(host) ||
      (host.endsWith(registrable) && /(careers?|jobs)/.test(host)) ||
      /^[a-z0-9-]*(careers|jobs)\.[a-z]{2,}$/.test(host);
    if (!isCareersHost) continue;
    seen.add(host);
    found.push(`https://${host}/`);
    if (found.length >= 3) break;
  }
  return found;
}

async function fetchText(url: string): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return { html: await response.text(), finalUrl: response.url || url };
  } catch {
    return null;
  }
}

/**
 * Careers destinations reachable from an employer's own site.
 *
 * Reads the homepage AND the conventional /careers landing page, because a
 * dedicated careers host is very often named only on the latter.
 */
export async function careersLinksFromHomepage(domain: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (url: string) => {
    const key = url.replace(/\/+$/, "");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(url);
  };

  for (const entry of [`https://${domain}/`, `https://${domain}/careers`]) {
    const page = await fetchText(entry);
    if (!page) continue;
    // Dedicated careers hosts first — they are the strongest signal available.
    for (const url of dedicatedCareersHostUrls(page.html, page.finalUrl)) push(url);
    for (const url of extractCareersLinks(page.html, page.finalUrl)) push(url);
    if (out.length >= MAX_HOMEPAGE_CAREERS_LINKS + 3) break;
  }
  return out.slice(0, MAX_HOMEPAGE_CAREERS_LINKS + 3);
}

/**
 * Try the employer's own domain for a careers page that identifies an ATS.
 *
 * Returns the ATS resolution plus the exact page that produced it, so the
 * evidence trail records what was actually crawled.
 */
/**
 * Confirms a tenant-slug board really is this employer's, before it is cached.
 *
 * Cheap by construction: the name/domain agreement above answers almost every
 * case with no network at all, and only a slug that agrees with nothing costs
 * one request to the vendor's own board-metadata endpoint.
 */
export async function boardBelongsToEmployer(
  atsType: string,
  atsIdentifier: string | null,
  companyName: string,
  domain: string | null,
): Promise<boolean> {
  if (!atsIdentifier) return true;
  if (atsType === "paylocity") {
    const tenant = parsePaylocityIdentifier(atsIdentifier);
    return Boolean(tenant && slugLooksLikeEmployer(tenant.slug, companyName, domain));
  }
  if (atsType === "oracle-recruiting-cloud") {
    const tenant = parseOracleRecruitingCloudIdentifier(atsIdentifier);
    if (!tenant) return false;
    try {
      const response = await fetch(
        `https://${tenant.host}/hcmUI/CandidateExperience/${encodeURIComponent(tenant.locale)}` +
          `/sites/${encodeURIComponent(tenant.siteNumber)}`,
        { headers: { "User-Agent": BOARD_PROBE_UA }, signal: AbortSignal.timeout(8_000) },
      );
      if (!response.ok) return false;
      const boardName = oracleRecruitingCloudBoardName(await response.text());
      return Boolean(boardName && boardNameMatchesCompany(boardName, companyName));
    } catch {
      return false;
    }
  }
  if (!TENANT_SLUG_VENDORS.has(atsType)) return true;
  if (slugLooksLikeEmployer(atsIdentifier, companyName, domain)) return true;

  if (atsType === "greenhouse") {
    try {
      const res = await fetch(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(atsIdentifier)}`,
        { headers: { "User-Agent": BOARD_PROBE_UA }, signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) return false;
      const meta = (await res.json()) as { name?: string };
      return Boolean(meta?.name && boardNameMatchesCompany(meta.name, companyName));
    } catch {
      return false;
    }
  }

  // Lever/Ashby/SmartRecruiters expose no comparable public identity endpoint,
  // so an unrelated slug stays unproven — and unproven means unresolved, never
  // published under the wrong employer.
  return false;
}

/**
 * The whole discovery cascade for one employer, with NO cache and NO writes.
 *
 * Exported so a diagnostic can measure what the pipeline is actually capable
 * of right now. resolveEmployerBoard answers from a negative-backoff cache by
 * design — correct in production, useless for the question "did the fix work",
 * because an employer given up on yesterday is not retried for hours.
 */
export async function discoverEmployerBoardConfig(
  companyName: string,
  domain: string,
): Promise<{ careersUrl: string; atsType: string; atsIdentifier: string; evidence: string } | null> {
  // Fetched at most once per employer: every pass below reuses this list.
  let homepageLinks: string[] | null = null;
  const linksFromSite = async (): Promise<string[]> => {
    if (homepageLinks === null) {
      homepageLinks = [];
      for (const host of hostCandidates(domain)) {
        homepageLinks.push(...(await careersLinksFromHomepage(host)));
        if (homepageLinks.length > 0) break;
      }
    }
    return homepageLinks;
  };

  for (const { host, path } of hostCandidates(domain).flatMap((host) =>
    CAREERS_PATHS.map((path) => ({ host, path })),
  )) {
    const careersUrl = `https://${host}${path}`;
    // Detect across EVERY vendor this codebase can actually read, not just the
    // five resolveAtsForCompany treats as "direct". A live measurement of 20
    // fresh signals found 18 of them at employers on iCIMS, SuccessFactors or
    // Taleo — vendors with working adapters here — so restricting detection to
    // Greenhouse/Lever/Ashby/SmartRecruiters/Workday discarded almost the whole
    // sample as "no ATS config".
    const detected = await detectAtsForCareersPage(careersUrl);
    if (!isReadableBoard(detected.atsType, detected.atsIdentifier)) continue;
    if (!(await boardBelongsToEmployer(detected.atsType, detected.atsIdentifier, companyName, domain))) continue;
    return {
      careersUrl,
      atsType: detected.atsType,
      atsIdentifier: detected.atsIdentifier ?? detected.atsType,
      evidence: JSON.stringify({
        method: "careers-page",
        crawledPage: careersUrl,
        confirmedAt: new Date().toISOString(),
      }),
    };
  }

  // Second pass: the employer's dedicated careers HOST. Cheap (root only) and
  // it is where large employers actually put the vendor.
  for (const careersUrl of careersHostUrls(domain)) {
    const detected = await detectAtsForCareersPage(careersUrl);
    if (!isReadableBoard(detected.atsType, detected.atsIdentifier)) continue;
    if (!(await boardBelongsToEmployer(detected.atsType, detected.atsIdentifier, companyName, domain))) continue;
    return {
      careersUrl,
      atsType: detected.atsType,
      atsIdentifier: detected.atsIdentifier ?? detected.atsType,
      evidence: JSON.stringify({
        method: "careers-host",
        crawledPage: careersUrl,
        confirmedAt: new Date().toISOString(),
      }),
    };
  }

  // Third pass: many large employers do not serve their careers site from a
  // conventional path at all — GlobalFoundries uses careers.gf.com, Procter &
  // Gamble uses a separate careers domain, Infineon redirects everything to a
  // marketing homepage. Following the "Careers" link the employer's OWN
  // homepage publishes reaches those, and is still employer-stated evidence
  // rather than a guess.
  for (const careersUrl of await linksFromSite()) {
    const detected = await detectAtsForCareersPage(careersUrl);
    if (!isReadableBoard(detected.atsType, detected.atsIdentifier)) continue;
    if (!(await boardBelongsToEmployer(detected.atsType, detected.atsIdentifier, companyName, domain))) continue;
    return {
      careersUrl,
      atsType: detected.atsType,
      atsIdentifier: detected.atsIdentifier ?? detected.atsType,
      evidence: JSON.stringify({
        method: "homepage-careers-link",
        crawledPage: careersUrl,
        linkedFrom: `https://${domain}/`,
        confirmedAt: new Date().toISOString(),
      }),
    };
  }

  // Third pass: the page may be a client-rendered shell that still embeds its
  // postings as schema.org JobPosting JSON-LD or a framework state blob, or
  // that embeds a classic ATS board in an iframe. "The HTML had no job links"
  // is not the same as "this employer has no jobs".
  for (const careersUrl of [
    ...CAREERS_PATHS.map((path) => `https://${domain}${path}`),
    ...(await linksFromSite()),
  ].slice(0, 8)) {
    const shell = await fetchRenderedShell(careersUrl, companyName);
    if (!shell) continue;

    if (
      shell.embeddedAts?.atsIdentifier
      && isReadableBoard(shell.embeddedAts.atsType, shell.embeddedAts.atsIdentifier)
      && (await boardBelongsToEmployer(shell.embeddedAts.atsType, shell.embeddedAts.atsIdentifier, companyName, domain))
    ) {
      return {
        careersUrl,
        atsType: shell.embeddedAts.atsType,
        atsIdentifier: shell.embeddedAts.atsIdentifier,
        evidence: JSON.stringify({
          method: "embedded-ats-board",
          crawledPage: careersUrl,
          confirmedAt: new Date().toISOString(),
        }),
      };
    }

    if (shell.jobs.length > 0) {
      return {
        careersUrl,
        atsType: "spa",
        atsIdentifier: careersUrl,
        evidence: JSON.stringify({
          method: "embedded-page-data",
          crawledPage: careersUrl,
          postingsFound: shell.jobs.length,
          apiHints: shell.apiHints,
          confirmedAt: new Date().toISOString(),
        }),
      };
    }

    // Last no-browser tier: the page may simply LINK to each official posting.
    // Benesch publishes its openings this way at /job-openings/ — no ATS
    // signature anywhere, no embedded JSON, just anchors to real job pages.
    if (shell.officialJobLinks > 0) {
      return {
        careersUrl,
        atsType: "employer-page",
        atsIdentifier: careersUrl,
        evidence: JSON.stringify({
          method: "employer-page-job-links",
          crawledPage: careersUrl,
          postingsFound: shell.officialJobLinks,
          confirmedAt: new Date().toISOString(),
        }),
      };
    }
  }

  // Fourth pass: render ONE careers page. Reached only when every no-browser
  // strategy above has failed, so the cost falls on exactly the employers that
  // cannot be read any other way — a careers site whose ATS signature and whose
  // postings both only exist after its own scripts run. The same pure detectors
  // are reused on the rendered DOM, and renderCareersPage enforces the browser
  // limits (one at a time, closed immediately, per-host cooldown).
  const renderTarget = (await linksFromSite())[0] ?? `https://${domain}/careers`;
  const rendered = await renderCareersPage(renderTarget);
  if (rendered) {
    const linked = detectAtsFromText(rendered.html);
    const clientRendered = detectClientRenderedAts(rendered.html, rendered.finalUrl);
    const detected = isReadableBoard(linked.atsType, linked.atsIdentifier)
      ? linked
      : clientRendered;

    if (
      isReadableBoard(detected.atsType, detected.atsIdentifier)
      && (await boardBelongsToEmployer(detected.atsType, detected.atsIdentifier, companyName, domain))
    ) {
      return {
        careersUrl: rendered.finalUrl,
        atsType: detected.atsType,
        atsIdentifier: detected.atsIdentifier ?? detected.atsType,
        evidence: JSON.stringify({
          method: "rendered-careers-page",
          crawledPage: rendered.finalUrl,
          confirmedAt: new Date().toISOString(),
        }),
      };
    }

    const shell = discoverFromRenderedShell(rendered.html, rendered.finalUrl, companyName);
    if (shell.jobs.length > 0 || shell.officialJobLinks > 0) {
      return {
        careersUrl: rendered.finalUrl,
        atsType: shell.jobs.length > 0 ? "spa" : "employer-page",
        atsIdentifier: rendered.finalUrl,
        evidence: JSON.stringify({
          method: "rendered-page-postings",
          crawledPage: rendered.finalUrl,
          postingsFound: shell.jobs.length || shell.officialJobLinks,
          confirmedAt: new Date().toISOString(),
        }),
      };
    }
  }

  // Fallback: conservative slug probing, which resolveAtsForCompany only allows
  // for boards that can confirm identity or whose slug came from this
  // employer's own name/domain.
  const probed = await resolveAtsForCompany(companyName, `https://${domain}`, { throttleMs: 150 });
  if (probed) {
    return {
      careersUrl: `https://${domain}`,
      atsType: probed.atsType,
      atsIdentifier: probed.atsIdentifier,
      evidence: JSON.stringify({
        method: probed.method,
        boardUrl: probed.boardUrl,
        postingCount: probed.postingCount,
        confirmedAt: new Date().toISOString(),
      }),
    };
  }
  return null;
}

/**
 * Resolve one employer to a board configuration usable by listJobsForCompany.
 *
 * `sourceDomain` is the website the DISCOVERY SOURCE published for this
 * employer. Pass null when the source gave none — this function will not
 * fabricate one.
 */
export async function resolveEmployerBoard(
  companyName: string,
  sourceDomain: string | null,
  approvedIndex: Map<string, CompanyForListing>,
  now: Date = new Date(),
): Promise<EmployerBoardOutcome> {
  const approved = findApprovedCompany(companyName, approvedIndex);
  if (approved && usableAts(approved.atsType) && approved.atsIdentifier) {
    return { ok: true, config: { ...approved, origin: "approved_company" } };
  }
  const publishedProvider = approved ? providerConfigFromPublishedCareersUrl(approved) : null;
  if (publishedProvider) return { ok: true, config: publishedProvider };

  const approvedDomain = approvedCareersDomain(approved);
  const key = normalizeCompanyKey(companyName);
  if (!key) return { ok: false, reason: "UNKNOWN_COMPANY" };

  const cached = await prisma.employerBoardResolution.findUnique({
    where: { normalizedCompany: key },
  });

  let cachedBoardWrongEmployer = false;
  if (
    cached?.state === "RESOLVED" &&
    usableAts(cached.atsType) &&
    cached.atsIdentifier &&
    cached.lastAttemptAt &&
    now.getTime() - cached.lastAttemptAt.getTime() < RESOLVED_TTL_MS
  ) {
    const belongs = await boardBelongsToEmployer(
      cached.atsType!,
      cached.atsIdentifier,
      companyName,
      sourceDomain ?? cached.companyDomain ?? approvedDomain,
    );
    if (belongs) {
      return {
        ok: true,
        config: {
          name: cached.companyName,
          atsType: cached.atsType,
          atsIdentifier: cached.atsIdentifier,
          careersUrl: cached.careersUrl,
          lastETag: null,
          lastModified: null,
          contentHash: null,
          origin: "cached_resolution",
        },
      };
    }
    cachedBoardWrongEmployer = true;
  }

  // Prefer the domain the source published; fall back to a domain a previous
  // pass already recorded for this employer (also source-published).
  const domain = sourceDomain ?? cached?.companyDomain ?? approvedDomain;
  const attempts = (cached?.attempts ?? 0) + 1;

  // A stale negative must not hide a provider linked by the exact approved
  // careers page. This may require one bounded render when plain HTTP is
  // blocked, then the positive result is persisted so later ticks stay cheap.
  const shouldProbePublishedPage = Boolean(
    approved
    && (
      !cached
      || cached.state === "RESOLVED"
      || !cached.evidence?.includes(RESOLUTION_STRATEGY_VERSION)
      || !cached.nextAttemptAt
      || cached.nextAttemptAt <= now
    ),
  );
  const publishedPageProvider = shouldProbePublishedPage && approved
    ? await discoverProviderFromPublishedCareersPage(approved, domain)
    : null;
  if (publishedPageProvider) {
    await prisma.employerBoardResolution.upsert({
      where: { normalizedCompany: key },
      create: {
        normalizedCompany: key,
        companyName,
        companyDomain: domain,
        careersUrl: publishedPageProvider.careersUrl,
        atsType: publishedPageProvider.atsType,
        atsIdentifier: publishedPageProvider.atsIdentifier,
        state: "RESOLVED",
        reasonCode: null,
        evidence: JSON.stringify({
          method: "approved-careers-page",
          strategyVersion: RESOLUTION_STRATEGY_VERSION,
          crawledPage: publishedPageProvider.careersUrl,
          confirmedAt: now.toISOString(),
        }),
        attempts,
        lastAttemptAt: now,
        nextAttemptAt: null,
      },
      update: {
        companyName,
        companyDomain: domain,
        careersUrl: publishedPageProvider.careersUrl,
        atsType: publishedPageProvider.atsType,
        atsIdentifier: publishedPageProvider.atsIdentifier,
        state: "RESOLVED",
        reasonCode: null,
        evidence: JSON.stringify({
          method: "approved-careers-page",
          strategyVersion: RESOLUTION_STRATEGY_VERSION,
          crawledPage: publishedPageProvider.careersUrl,
          confirmedAt: now.toISOString(),
        }),
        attempts,
        lastAttemptAt: now,
        nextAttemptAt: null,
      },
    });
    return { ok: true, config: publishedPageProvider };
  }

  // A cached negative that has not aged out is answered from cache: re-crawling
  // the same employer every five minutes is exactly the load this cache exists
  // to prevent.
  if (cached && cached.state !== "RESOLVED" && cached.nextAttemptAt && cached.nextAttemptAt > now) {
    const cachedReason = cached.reasonCode === "UNKNOWN_COMPANY"
      ? "UNKNOWN_COMPANY"
      : cached.reasonCode === "BOARD_WRONG_EMPLOYER"
        ? "BOARD_WRONG_EMPLOYER"
        : "NO_ATS_CONFIG";
    return {
      ok: false,
      reason: cachedReason,
    };
  }

  if (!domain) {
    await recordResolutionAttempt({
      key,
      companyName,
      domain: null,
      attempts,
      now,
      reason: "UNKNOWN_COMPANY",
    });
    return { ok: false, reason: "UNKNOWN_COMPANY" };
  }

  const discovered = await discoverEmployerBoardConfig(companyName, domain);
  if (!discovered) {
    const reason = cachedBoardWrongEmployer ? "BOARD_WRONG_EMPLOYER" : "NO_ATS_CONFIG";
    await recordResolutionAttempt({
      key,
      companyName,
      domain,
      attempts,
      now,
      reason,
    });
    return { ok: false, reason };
  }

  await prisma.employerBoardResolution.upsert({
    where: { normalizedCompany: key },
    create: {
      normalizedCompany: key,
      companyName,
      companyDomain: domain,
      careersUrl: discovered.careersUrl,
      atsType: discovered.atsType,
      atsIdentifier: discovered.atsIdentifier,
      state: "RESOLVED",
      reasonCode: null,
      evidence: discovered.evidence,
      attempts,
      lastAttemptAt: now,
      nextAttemptAt: null,
    },
    update: {
      companyName,
      companyDomain: domain,
      careersUrl: discovered.careersUrl,
      atsType: discovered.atsType,
      atsIdentifier: discovered.atsIdentifier,
      state: "RESOLVED",
      reasonCode: null,
      evidence: discovered.evidence,
      attempts,
      lastAttemptAt: now,
      nextAttemptAt: null,
    },
  });

  return {
    ok: true,
    config: {
      name: companyName,
      atsType: discovered.atsType,
      atsIdentifier: discovered.atsIdentifier,
      careersUrl: discovered.careersUrl,
      lastETag: null,
      lastModified: null,
      contentHash: null,
      origin: "discovered",
    },
  };
}

function approvedCareersDomain(approved: CompanyForListing | null): string | null {
  if (!approved?.careersUrl) return null;
  try {
    return new URL(approved.careersUrl).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function recordResolutionAttempt(args: {
  key: string;
  companyName: string;
  domain: string | null;
  attempts: number;
  now: Date;
  reason: FreshSignalReason;
}): Promise<void> {
  const nextAttemptAt = new Date(args.now.getTime() + negativeBackoffMs(args.attempts));
  const shared = {
    companyName: args.companyName,
    companyDomain: args.domain,
    state: "UNRESOLVED",
    reasonCode: args.reason,
    attempts: args.attempts,
    lastAttemptAt: args.now,
    nextAttemptAt,
    evidence: JSON.stringify({ strategyVersion: RESOLUTION_STRATEGY_VERSION }),
  };
  await prisma.employerBoardResolution.upsert({
    where: { normalizedCompany: args.key },
    create: { normalizedCompany: args.key, ...shared },
    update: shared,
  });
}

/**
 * Force one employer's cached board configuration to be re-derived.
 *
 * A cached RESOLVED configuration is trusted for a week, which is right when
 * it works and actively harmful when it does not. IBM was cached as an
 * `employer-page` pointing at careers.ibm.com — syntactically valid, reachable,
 * and returning exactly one unrelated posting from Taiwan, for a week, while
 * nine fresh IBM internships went unresolved every tick.
 *
 * A configuration that reads zero usable postings is evidence about the
 * configuration, not about the employer. Clearing it lets the cascade — which
 * now knows about IBM's own search API, careers hosts and Workable — try
 * again, and the negative-backoff path still prevents a re-crawl storm if the
 * rediscovery also fails.
 */
export async function invalidateBoardResolution(
  companyName: string,
  reason: string,
): Promise<boolean> {
  const key = normalizeCompanyKey(companyName);
  if (!key) return false;

  const existing = await prisma.employerBoardResolution.findUnique({
    where: { normalizedCompany: key },
    select: { state: true, atsType: true },
  });
  // Only a RESOLVED row is cleared. An UNRESOLVED one is already carrying its
  // own backoff, and resetting that would turn a settled miss into a retry
  // loop against an employer that has nothing to give.
  if (existing?.state !== "RESOLVED") return false;

  await prisma.employerBoardResolution.update({
    where: { normalizedCompany: key },
    data: {
      state: "STALE",
      reasonCode: null,
      atsType: null,
      atsIdentifier: null,
      evidence: JSON.stringify({
        invalidatedAt: new Date().toISOString(),
        previousAtsType: existing.atsType,
        reason,
      }),
      // Re-derivable immediately: the point is to try a better cascade now.
      nextAttemptAt: null,
    },
  });
  return true;
}
