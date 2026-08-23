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
import { detectAtsForCareersPage } from "@/lib/ats/detect";
import { resolveAtsForCompany } from "@/lib/ats/resolve";
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
  | { ok: false; reason: Extract<FreshSignalReason, "UNKNOWN_COMPANY" | "NO_ATS_CONFIG"> };

const ONE_HOUR_MS = 60 * 60 * 1000;
/** How long a successful board resolution is reused before being re-proved. */
const RESOLVED_TTL_MS = 7 * 24 * ONE_HOUR_MS;
/** Backoff ceiling for employers we could not resolve. */
const MAX_NEGATIVE_BACKOFF_MS = 14 * 24 * ONE_HOUR_MS;

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
  return ["greenhouse", "lever", "ashby", "smartrecruiters", "workday", "icims", "taleo"].includes(
    atsType,
  );
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
const MAX_HOMEPAGE_CAREERS_LINKS = 4;

/**
 * Careers destinations the employer's own homepage links to.
 *
 * Deliberately allows a different hostname: an employer that publishes its
 * careers site at careers.example.com or examplecareers.com has still stated
 * that destination itself. What is never allowed is a hostname nobody stated.
 */
export function extractCareersLinks(html: string, homepageUrl: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
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
    // A link straight into a known ATS is handled by detection anyway; keep it,
    // it is the strongest possible hit.
    const normalized = `https://${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    found.push(url.toString());
    if (found.length >= MAX_HOMEPAGE_CAREERS_LINKS) break;
  }
  return found;
}

export async function careersLinksFromHomepage(domain: string): Promise<string[]> {
  try {
    const response = await fetch(`https://${domain}/`, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return [];
    return extractCareersLinks(await response.text(), response.url || `https://${domain}/`);
  } catch {
    return [];
  }
}

/**
 * Try the employer's own domain for a careers page that identifies an ATS.
 *
 * Returns the ATS resolution plus the exact page that produced it, so the
 * evidence trail records what was actually crawled.
 */
async function discoverBoardFromDomain(
  companyName: string,
  domain: string,
): Promise<{ careersUrl: string; atsType: string; atsIdentifier: string; evidence: string } | null> {
  for (const path of CAREERS_PATHS) {
    const careersUrl = `https://${domain}${path}`;
    // Detect across EVERY vendor this codebase can actually read, not just the
    // five resolveAtsForCompany treats as "direct". A live measurement of 20
    // fresh signals found 18 of them at employers on iCIMS, SuccessFactors or
    // Taleo — vendors with working adapters here — so restricting detection to
    // Greenhouse/Lever/Ashby/SmartRecruiters/Workday discarded almost the whole
    // sample as "no ATS config".
    const detected = await detectAtsForCareersPage(careersUrl);
    if (!isReadableBoard(detected.atsType, detected.atsIdentifier)) continue;
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

  // Second pass: many large employers do not serve their careers site from a
  // conventional path at all — GlobalFoundries uses careers.gf.com, Procter &
  // Gamble uses a separate careers domain, Infineon redirects everything to a
  // marketing homepage. Following the "Careers" link the employer's OWN
  // homepage publishes reaches those, and is still employer-stated evidence
  // rather than a guess.
  for (const careersUrl of await careersLinksFromHomepage(domain)) {
    const detected = await detectAtsForCareersPage(careersUrl);
    if (!isReadableBoard(detected.atsType, detected.atsIdentifier)) continue;
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

  const key = normalizeCompanyKey(companyName);
  if (!key) return { ok: false, reason: "UNKNOWN_COMPANY" };

  const cached = await prisma.employerBoardResolution.findUnique({
    where: { normalizedCompany: key },
  });

  if (
    cached?.state === "RESOLVED" &&
    usableAts(cached.atsType) &&
    cached.atsIdentifier &&
    cached.lastAttemptAt &&
    now.getTime() - cached.lastAttemptAt.getTime() < RESOLVED_TTL_MS
  ) {
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

  // A cached negative that has not aged out is answered from cache: re-crawling
  // the same employer every five minutes is exactly the load this cache exists
  // to prevent.
  if (cached && cached.state !== "RESOLVED" && cached.nextAttemptAt && cached.nextAttemptAt > now) {
    return {
      ok: false,
      reason: cached.reasonCode === "UNKNOWN_COMPANY" ? "UNKNOWN_COMPANY" : "NO_ATS_CONFIG",
    };
  }

  // Prefer the domain the source published; fall back to a domain a previous
  // pass already recorded for this employer (also source-published).
  const domain = sourceDomain ?? cached?.companyDomain ?? approvedCareersDomain(approved);
  const attempts = (cached?.attempts ?? 0) + 1;

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

  const discovered = await discoverBoardFromDomain(companyName, domain);
  if (!discovered) {
    await recordResolutionAttempt({
      key,
      companyName,
      domain,
      attempts,
      now,
      reason: "NO_ATS_CONFIG",
    });
    return { ok: false, reason: "NO_ATS_CONFIG" };
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
  };
  await prisma.employerBoardResolution.upsert({
    where: { normalizedCompany: args.key },
    create: { normalizedCompany: args.key, ...shared },
    update: shared,
  });
}
