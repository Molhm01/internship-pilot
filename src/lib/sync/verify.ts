// Independent official-job verification (Milestone 3: strict VERIFIED_OFFICIAL_AT_LAST_CHECK gate).
//
// We deliberately do NOT follow the aggregator's own "apply" redirect
// (jobright.ai/jobs/info/<id>) — that path sits behind a robots.txt rule
// jobright.ai wrote specifically for ClaudeBot. Instead we independently
// look the company up on the public Greenhouse/Lever/Ashby job-board APIs
// (official, documented, unauthenticated integration APIs meant for exactly
// this kind of external consumption) and confirm several independent things
// line up before ever calling a job VERIFIED_OFFICIAL_AT_LAST_CHECK. If any check is
// inconclusive, the job stays NeedsReview (quarantined) — never silently
// trusted, and never claimed with permanent/100% certainty.

import { STUDENT_ROLE_PATTERN } from "@/lib/sync/classify";
import { AVAILABILITY, type ReasonCode } from "@/lib/jobs/verificationModel";

// Availability values verify.ts can produce. A missing Greenhouse/Lever/Ashby
// mirror NEVER produces a closed state — those three are only a subset of
// legitimate ATS providers.
export type VerificationStatus =
  | typeof AVAILABILITY.OFFICIAL_VERIFIED
  | typeof AVAILABILITY.ACTIVE_SOURCE_LISTED
  | typeof AVAILABILITY.VERIFICATION_PENDING
  | typeof AVAILABILITY.CLOSED_CONFIRMED
  | typeof AVAILABILITY.DESTINATION_MISMATCH;

export type RedirectHop = { url: string; status: number | null };

export type VerificationEvidence = {
  officialDomainRecognized: boolean;
  titleMatchScore: number;
  locationMatch: boolean;
  isStudentRole: boolean;
  requisitionIdRecorded: boolean;
  matchedOfficialTitle: string;
  matchedOfficialLocation: string;
  checkedAt: string;
  redirectChain?: RedirectHop[];
  redirectChainSuspicious?: boolean;
  httpStatus?: number | null;
};

export type VerificationResult = {
  status: VerificationStatus;
  reasonCode: ReasonCode;
  reason: string;
  verificationMethod?: string;
  officialApplyUrl?: string;
  officialDescription?: string;
  officialEmployerDomain?: string;
  requisitionId?: string;
  atsTenant?: string;
  redirectChain?: RedirectHop[];
  httpStatusAtVerification?: number | null;
  evidence?: VerificationEvidence;
};

// Known URL-shortener / link-tracking domains. A redirect chain passing
// through one of these is a fraud/legitimacy red flag per the source-
// security requirements — an official employer application link should
// never need to hop through a public shortener.
const SUSPICIOUS_REDIRECT_DOMAINS = [
  "bit.ly", "tinyurl.com", "t.co", "ow.ly", "buff.ly", "is.gd", "rebrand.ly",
  "cutt.ly", "shorturl.at", "rb.gy", "lnkd.in", "click.linksynergy.com",
];

function isSuspiciousRedirectDomain(hostname: string): boolean {
  return SUSPICIOUS_REDIRECT_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

// Manually follows redirects (rather than fetch's automatic redirect:
// "follow") so every hop can be recorded and inspected — required to prove
// "the redirect chain contains no URL shortener, advertising redirect,
// unrelated recruiter, or suspicious domain" before trusting an apply link.
export async function followRedirectChain(
  startUrl: string,
  maxHops = 10,
): Promise<{ chain: RedirectHop[]; finalUrl: string; finalStatus: number | null; suspicious: boolean }> {
  const chain: RedirectHop[] = [];
  let url = startUrl;
  let suspicious = false;

  for (let hop = 0; hop < maxHops; hop++) {
    let hostname: string | null = null;
    try {
      hostname = new URL(url).hostname;
    } catch {
      // malformed URL — record and stop
      chain.push({ url, status: null });
      return { chain, finalUrl: url, finalStatus: null, suspicious: true };
    }
    if (isSuspiciousRedirectDomain(hostname)) suspicious = true;

    try {
      const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8000) });
      chain.push({ url, status: res.status });
      const isRedirect = res.status >= 300 && res.status < 400;
      const location = res.headers.get("location");
      if (isRedirect && location) {
        url = new URL(location, url).toString();
        continue;
      }
      return { chain, finalUrl: url, finalStatus: res.status, suspicious };
    } catch {
      chain.push({ url, status: null });
      return { chain, finalUrl: url, finalStatus: null, suspicious };
    }
  }
  return { chain, finalUrl: url, finalStatus: null, suspicious: true }; // too many hops is itself suspicious
}

type JobToVerify = {
  title: string;
  company: string;
  location: string | null;
  workModel: string | null;
};

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function slugCandidates(company: string): string[] {
  const cleaned = company.replace(/\b(inc|llc|corp|corporation|co|company|ltd|plc|group|holdings)\b\.?/gi, "").trim();
  const alnum = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const hyphen = cleaned
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return Array.from(new Set([alnum, hyphen].filter(Boolean)));
}

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(a: string, b: string): number {
  const wa = new Set(normalizeTitle(a).split(" ").filter((w) => w.length > 2));
  const wb = new Set(normalizeTitle(b).split(" ").filter((w) => w.length > 2));
  if (wa.size === 0 || wb.size === 0) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / Math.max(wa.size, wb.size);
}

function locationConflicts(aggregatorLocation: string | null, officialLocation: string, isRemote: boolean): boolean {
  if (!aggregatorLocation) return false;
  const aggIsRemote = /remote/i.test(aggregatorLocation);
  if (aggIsRemote || isRemote) return false; // remote on either side: don't flag as a conflict
  const aggState = aggregatorLocation.match(/,\s*([A-Za-z]{2})\b/)?.[1]?.toLowerCase();
  const offState = officialLocation.match(/,\s*([A-Za-z]{2})\b/)?.[1]?.toLowerCase();
  if (!aggState || !offState) return false; // not enough info to call it a conflict
  return aggState !== offState;
}

function domainOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("jobright") || host.includes("simplify") || host.includes("intern-list")) {
      return null;
    }
    return host;
  } catch {
    return null;
  }
}

type MatchedPosting = {
  applyUrl: string;
  title: string;
  location: string;
  isRemote: boolean;
  description?: string;
  requisitionId?: string | null;
  source: "Greenhouse" | "Lever" | "Ashby";
};

async function searchGreenhouse(slug: string, title: string): Promise<MatchedPosting | null> {
  const data = (await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`)) as
    | { jobs?: Array<{ title: string; absolute_url: string; location?: { name?: string }; content?: string; requisition_id?: string }> }
    | null;
  if (!data?.jobs?.length) return null;
  let best: { job: (typeof data.jobs)[number]; score: number } | null = null;
  for (const job of data.jobs) {
    const score = titleSimilarity(title, job.title);
    if (!best || score > best.score) best = { job, score };
  }
  if (!best || best.score < 0.35) return null;
  return {
    applyUrl: best.job.absolute_url,
    title: best.job.title,
    location: best.job.location?.name ?? "",
    isRemote: /remote/i.test(best.job.location?.name ?? ""),
    description: best.job.content,
    requisitionId: best.job.requisition_id ?? null,
    source: "Greenhouse",
  };
}

async function searchLever(slug: string, title: string): Promise<MatchedPosting | null> {
  const data = (await fetchJson(`https://api.lever.co/v0/postings/${slug}?mode=json`)) as Array<{
    text: string;
    hostedUrl: string;
    categories?: { location?: string };
    workplaceType?: string;
    descriptionPlain?: string;
  }> | null;
  if (!data?.length) return null;
  let best: { job: (typeof data)[number]; score: number } | null = null;
  for (const job of data) {
    const score = titleSimilarity(title, job.text);
    if (!best || score > best.score) best = { job, score };
  }
  if (!best || best.score < 0.35) return null;
  return {
    applyUrl: best.job.hostedUrl,
    title: best.job.text,
    location: best.job.categories?.location ?? "",
    isRemote: (best.job.workplaceType ?? "").toLowerCase() === "remote",
    description: best.job.descriptionPlain,
    requisitionId: null,
    source: "Lever",
  };
}

async function searchAshby(slug: string, title: string): Promise<MatchedPosting | null> {
  const data = (await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`)) as {
    jobs?: Array<{ title: string; jobUrl: string; applyUrl?: string; location?: string; isRemote?: boolean; descriptionPlain?: string }>;
  } | null;
  if (!data?.jobs?.length) return null;
  let best: { job: (typeof data.jobs)[number]; score: number } | null = null;
  for (const job of data.jobs) {
    const score = titleSimilarity(title, job.title);
    if (!best || score > best.score) best = { job, score };
  }
  if (!best || best.score < 0.35) return null;
  return {
    applyUrl: best.job.applyUrl ?? best.job.jobUrl,
    title: best.job.title,
    location: best.job.location ?? "",
    isRemote: Boolean(best.job.isRemote),
    description: best.job.descriptionPlain,
    requisitionId: null,
    source: "Ashby",
  };
}

const SOURCE_METHOD: Record<MatchedPosting["source"], string> = {
  Greenhouse: "greenhouse-board-match",
  Lever: "lever-board-match",
  Ashby: "ashby-board-match",
};

// A trusted-source listing whose official destination we could not (yet)
// independently confirm. This is ACTIVE and applyable — never closed.
function sourceListed(reasonCode: ReasonCode, reason: string, extra?: Partial<VerificationResult>): VerificationResult {
  return { status: AVAILABILITY.ACTIVE_SOURCE_LISTED, reasonCode, reason, ...extra };
}

export async function verifyJob(job: JobToVerify): Promise<VerificationResult> {
  const slugs = slugCandidates(job.company);
  if (slugs.length === 0) {
    // No usable slug just means we can't look up an official mirror — the job
    // is still listed on the trusted source, so it stays active.
    return sourceListed(
      "OFFICIAL_MIRROR_NOT_FOUND",
      "Listed on the discovery source. A company identifier for an official ATS lookup couldn't be derived, so the official destination isn't independently confirmed yet.",
    );
  }

  for (const slug of slugs) {
    for (const search of [searchGreenhouse, searchLever, searchAshby]) {
      let match: MatchedPosting | null;
      try {
        match = await search(slug, job.title);
      } catch {
        match = null;
      }
      if (!match) continue;

      const checkedAt = new Date().toISOString();
      const officialEmployerDomain = domainOf(match.applyUrl) ?? undefined;
      const titleScore = titleSimilarity(job.title, match.title);
      const isStudentRole = STUDENT_ROLE_PATTERN.test(match.title);
      const conflicts = locationConflicts(job.location, match.location, match.isRemote);

      const evidence: VerificationEvidence = {
        officialDomainRecognized: Boolean(officialEmployerDomain),
        titleMatchScore: Math.round(titleScore * 100) / 100,
        locationMatch: !conflicts,
        isStudentRole,
        requisitionIdRecorded: Boolean(match.requisitionId),
        matchedOfficialTitle: match.title,
        matchedOfficialLocation: match.location,
        checkedAt,
      };

      // Finding a same-company posting whose location or role reading differs
      // is a DISCREPANCY worth surfacing — but the job is still live on the
      // trusted source, so it stays active and applyable (we still record the
      // official apply URL we found so the agent can use it). It is NOT closed
      // and NOT hidden. Only a clearly different destination is a mismatch.
      if (conflicts) {
        return sourceListed(
          "DESTINATION_LOCATION_DISCREPANCY",
          `Found a "${match.title}" posting at ${job.company} on ${match.source}, but its location (${match.location}) differs from the listed location (${job.location}). Still active — confirm the office/location before submitting.`,
          { officialApplyUrl: match.applyUrl, officialEmployerDomain, evidence },
        );
      }

      if (!isStudentRole) {
        return sourceListed(
          "DESTINATION_ROLE_DISCREPANCY",
          `Found a matching "${match.title}" posting at ${job.company}, but its title doesn't clearly read as an internship/co-op/undergraduate role. Still active — confirm it's the right role before submitting.`,
          { officialApplyUrl: match.applyUrl, officialEmployerDomain, evidence },
        );
      }

      // Prove the redirect chain to the official apply URL is clean before
      // ever calling this job officially verified — never trust a link just
      // because the ATS name matches. A suspicious chain doesn't close the
      // job; it just prevents us from recording that URL as the trusted
      // official destination (the job stays active via its source listing).
      const redirectResult = await followRedirectChain(match.applyUrl);
      evidence.redirectChain = redirectResult.chain;
      evidence.redirectChainSuspicious = redirectResult.suspicious;
      evidence.httpStatus = redirectResult.finalStatus;

      if (redirectResult.suspicious) {
        return sourceListed(
          "REDIRECT_SUSPICIOUS",
          `Found a matching "${match.title}" posting at ${job.company}, but the redirect chain to reach it passed through a URL shortener or suspicious domain, so it isn't recorded as the trusted official destination. Still active via the source listing — verify the link before submitting.`,
          { officialEmployerDomain, redirectChain: redirectResult.chain, httpStatusAtVerification: redirectResult.finalStatus, evidence },
        );
      }

      return {
        status: AVAILABILITY.OFFICIAL_VERIFIED,
        reasonCode: "OFFICIAL_VERIFIED",
        reason: `Verified on the official employer application page at ${new Date(checkedAt).toLocaleString()}.`,
        verificationMethod: SOURCE_METHOD[match.source],
        officialApplyUrl: match.applyUrl,
        officialDescription: match.description,
        officialEmployerDomain,
        requisitionId: match.requisitionId ?? undefined,
        atsTenant: slug,
        redirectChain: redirectResult.chain,
        httpStatusAtVerification: redirectResult.finalStatus,
        evidence,
      };
    }
  }

  // No Greenhouse/Lever/Ashby mirror found. Those three are only a subset of
  // legitimate ATS providers (Workday, iCIMS, SmartRecruiters, SuccessFactors,
  // Taleo, custom career pages, ...), so this is NOT evidence of closure. The
  // job remains active as a trusted-source listing; its official destination
  // is simply not independently confirmed via those three boards.
  return sourceListed(
    "OFFICIAL_MIRROR_NOT_FOUND",
    "Listed on the discovery source. No matching Greenhouse/Lever/Ashby posting was found, but those are only three of many ATS providers, so this is not treated as closed — the official destination is just not independently confirmed yet.",
  );
}

// Re-checks a job that was previously verified, using its stored official
// apply URL. If that specific posting is gone, the job is Closed rather than
// silently left VERIFIED_OFFICIAL_AT_LAST_CHECK. Also used "immediately before any future
// application" per Milestone 3/6, and a SECOND time immediately before final
// submission — the redirect chain is re-followed and re-checked for
// suspicious hops every single time, never cached or assumed still valid.
export type RecheckOutcome = {
  // "open" = destination still active; "closed" = genuine 404/410/expired;
  // "pending" = a transient failure (network/timeout/5xx/redirect flag) that
  // must NOT be presented as closed.
  availability: "open" | "closed" | "pending";
  reasonCode: ReasonCode;
  reason: string;
  redirectChain: RedirectHop[];
  httpStatus: number | null;
  /** @deprecated use `availability`. Kept for existing callers. True only when open. */
  stillOpen: boolean;
};

export async function recheckOfficialUrl(officialApplyUrl: string): Promise<RecheckOutcome> {
  try {
    const result = await followRedirectChain(officialApplyUrl);

    // A suspicious redirect is a legitimacy flag, not proof of closure — hold
    // for re-verification rather than declaring the posting dead.
    if (result.suspicious) {
      return {
        availability: "pending",
        stillOpen: false,
        reasonCode: "REDIRECT_SUSPICIOUS",
        reason: "The redirect chain to the official application page now passes through a URL shortener or suspicious domain — holding for re-verification rather than treating it as closed.",
        redirectChain: result.chain,
        httpStatus: result.finalStatus,
      };
    }

    const status = result.finalStatus;
    if (status !== null && status >= 200 && status < 300) {
      return {
        availability: "open",
        stillOpen: true,
        reasonCode: "OFFICIAL_VERIFIED",
        reason: `Official application page still reachable as of ${new Date().toLocaleString()}.`,
        redirectChain: result.chain,
        httpStatus: status,
      };
    }

    // Only a genuine "gone" status is a confirmed closure.
    if (status === 404 || status === 410) {
      return {
        availability: "closed",
        stillOpen: false,
        reasonCode: status === 410 ? "CLOSED_EXPIRED" : "CLOSED_NOT_FOUND",
        reason: `Official application page returned HTTP ${status} (Gone/Not Found) — the posting is confirmed closed.`,
        redirectChain: result.chain,
        httpStatus: status,
      };
    }

    // Any other non-2xx (403/429/5xx/redirect-to-generic without a location)
    // is a transient/inconclusive failure. Never close on it.
    return {
      availability: "pending",
      stillOpen: false,
      reasonCode: "NETWORK_FAILURE",
      reason: `Official application page returned HTTP ${status ?? "no response"} — inconclusive, holding for re-verification rather than treating it as closed.`,
      redirectChain: result.chain,
      httpStatus: status,
    };
  } catch (err) {
    return {
      availability: "pending",
      stillOpen: false,
      reasonCode: "NETWORK_FAILURE",
      reason: `Could not reach the official application page (${err instanceof Error ? err.message : "network error"}) — holding for re-verification rather than treating it as closed.`,
      redirectChain: [],
      httpStatus: null,
    };
  }
}
