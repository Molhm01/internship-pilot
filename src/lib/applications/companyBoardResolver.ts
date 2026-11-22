import { prisma } from "@/lib/db";
import { detectAtsFromText } from "@/lib/ats/detect";
import {
  destinationPersistenceData,
  isAggregatorUrl,
  isValidOfficialApplicationUrl,
  resolveOfficialJobDestination,
} from "@/lib/applications/officialDestination";

const COMPANY_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "companies",
  "group",
  "holdings",
  "the",
]);

const GENERIC_TITLE_TOKENS = new Set([
  "intern",
  "internship",
  "co",
  "coop",
  "summer",
  "spring",
  "fall",
  "winter",
  "2026",
  "2027",
  "2028",
  "undergrad",
  "undergraduate",
  "student",
  "program",
  "full",
  "time",
  "remote",
  "us",
  "usa",
]);

export function normalizeCompanyMatchKey(name: string): string {
  const tokens = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !COMPANY_SUFFIXES.has(t));
  return tokens.join(" ").trim() || name.trim().toLowerCase();
}

export function tokenizeRoleTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/\bsoftware engineer\b/g, "software engineering")
    .replace(/\bmachine learning\b/g, "ml ai")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/**
 * Computes a domain-aware similarity score (0..1) between two internship titles
 * so e.g. "Summer 2027 AI Engineering Internship" cleanly matches
 * "Summer 2027 Software Engineering AI Intern" at the same employer.
 */
export function scoreTitleSimilarity(titleA: string, titleB: string): number {
  const aTokens = tokenizeRoleTitle(titleA);
  const bTokens = tokenizeRoleTitle(titleB);
  if (aTokens.length === 0 || bTokens.length === 0) return 0;

  const setA = new Set(aTokens);
  const setB = new Set(bTokens);
  let weightedIntersection = 0;
  let weightedUnion = 0;
  const all = new Set([...setA, ...setB]);

  for (const token of all) {
    const weight = GENERIC_TITLE_TOKENS.has(token) ? 0.5 : 2.0;
    weightedUnion += weight;
    if (setA.has(token) && setB.has(token)) {
      weightedIntersection += weight;
    }
  }

  return weightedUnion > 0 ? weightedIntersection / weightedUnion : 0;
}

interface BoardCandidate {
  title: string;
  url: string;
  atsType: string;
  atsTenant?: string | null;
}

async function searchLivePublicBoard(
  atsType: string,
  atsIdentifier: string,
): Promise<BoardCandidate[]> {
  try {
    if (atsType === "greenhouse") {
      const res = await fetch(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(atsIdentifier)}/jobs`,
        { signal: AbortSignal.timeout(6_000) },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { jobs?: Array<{ title?: string; absolute_url?: string }> };
      return (data.jobs ?? [])
        .filter((j): j is { title: string; absolute_url: string } => Boolean(j.title && j.absolute_url))
        .map((j) => ({ title: j.title, url: j.absolute_url, atsType: "greenhouse", atsTenant: atsIdentifier }));
    }
    if (atsType === "lever") {
      const res = await fetch(
        `https://api.lever.co/v0/postings/${encodeURIComponent(atsIdentifier)}?mode=json`,
        { signal: AbortSignal.timeout(6_000) },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as Array<{ text?: string; hostedUrl?: string; applyUrl?: string }>;
      return (Array.isArray(data) ? data : [])
        .filter((j) => Boolean(j.text && (j.applyUrl || j.hostedUrl)))
        .map((j) => ({
          title: j.text!,
          url: j.applyUrl || j.hostedUrl!,
          atsType: "lever",
          atsTenant: atsIdentifier,
        }));
    }
    if (atsType === "ashby") {
      const res = await fetch(
        `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(atsIdentifier)}`,
        { signal: AbortSignal.timeout(6_000) },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { jobs?: Array<{ title?: string; jobUrl?: string; applyUrl?: string }> };
      return (data.jobs ?? [])
        .filter((j) => Boolean(j.title && (j.applyUrl || j.jobUrl)))
        .map((j) => ({
          title: j.title!,
          url: j.applyUrl || j.jobUrl!,
          atsType: "ashby",
          atsTenant: atsIdentifier,
        }));
    }
  } catch {
    // Non-fatal public board lookup failure
  }
  return [];
}

export interface OfficialAtsResolutionResult {
  resolved: boolean;
  url: string | null;
  atsType: string | null;
  method: "already_resolved" | "outbound_redirect" | "company_sibling_job" | "company_live_board" | "unresolved";
}

/**
 * Resolves a job posting from an aggregator source (LinkedIn, Indeed, Jobright,
 * Intern-List, Simplify) to the employer's canonical direct ATS URL before
 * running automated form fill/submission.
 */
export async function resolveAggregatorJobToOfficialAts(
  jobId: string,
): Promise<OfficialAtsResolutionResult> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    return { resolved: false, url: null, atsType: null, method: "unresolved" };
  }

  const stored = job.officialApplicationUrl ?? job.officialApplyUrl ?? job.url;
  if (
    job.resolutionStatus === "RESOLVED"
    && stored
    && isValidOfficialApplicationUrl(stored)
    && !isAggregatorUrl(stored)
  ) {
    return {
      resolved: true,
      url: stored,
      atsType: job.atsType ?? detectAtsFromText(stored).atsType,
      method: "already_resolved",
    };
  }

  // 1. Try following outbound ATS links / HTTP redirects on the stored listing URL
  const direct = await resolveOfficialJobDestination(
    {
      sourceListingUrl: job.sourceListingUrl ?? job.sourceUrl,
      officialApplicationUrl: job.officialApplicationUrl,
      originalJobPostUrl: job.originalJobPostUrl,
      sourceUrl: job.sourceUrl,
      officialApplyUrl: job.officialApplyUrl,
      officialJobUrl: job.officialJobUrl,
      jobDescriptionSourceUrl: job.jobDescriptionSourceUrl,
      url: job.url,
      verificationStatus: job.verificationStatus,
      resolutionStatus: job.resolutionStatus,
    },
    fetch,
    new Date(),
    { followSourceListings: true },
  );

  if (
    direct.resolutionStatus === "RESOLVED"
    && direct.officialApplicationUrl
    && isValidOfficialApplicationUrl(direct.officialApplicationUrl)
    && !isAggregatorUrl(direct.officialApplicationUrl)
  ) {
    const ats = detectAtsFromText(direct.officialApplicationUrl);
    await prisma.job.update({
      where: { id: job.id },
      data: {
        ...destinationPersistenceData(direct),
        verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
        verificationMethod: `auto-resolved:${direct.resolutionMethod}`,
        verificationReason: "Resolved official employer ATS URL automatically from listing destination.",
        lastVerifiedAt: new Date(),
        ...(ats.atsType !== "unknown" ? { atsType: ats.atsType, atsTenant: ats.atsIdentifier } : {}),
      },
    });
    return {
      resolved: true,
      url: direct.officialApplicationUrl,
      atsType: ats.atsType,
      method: "outbound_redirect",
    };
  }

  // 2. Check existing already-resolved official ATS jobs for the exact same company
  const targetCompanyKey = normalizeCompanyMatchKey(job.company);
  const resolvedJobs = await prisma.job.findMany({
    where: { activeFeed: true, resolutionStatus: "RESOLVED" },
    select: {
      id: true,
      company: true,
      title: true,
      officialApplicationUrl: true,
      officialApplyUrl: true,
      url: true,
      atsType: true,
      atsTenant: true,
    },
  });

  const companySiblings = resolvedJobs.filter(
    (s) => s.id !== job.id && normalizeCompanyMatchKey(s.company) === targetCompanyKey,
  );

  let bestSibling: { url: string; atsType: string; atsTenant: string | null; score: number } | null = null;
  for (const sibling of companySiblings) {
    const siblingUrl = sibling.officialApplicationUrl ?? sibling.officialApplyUrl ?? sibling.url;
    if (!siblingUrl || isAggregatorUrl(siblingUrl) || !isValidOfficialApplicationUrl(siblingUrl)) {
      continue;
    }
    const similarity = scoreTitleSimilarity(job.title, sibling.title);
    if (!bestSibling || similarity > bestSibling.score) {
      const detected = detectAtsFromText(siblingUrl);
      bestSibling = {
        url: siblingUrl,
        atsType: sibling.atsType && sibling.atsType !== "unknown" ? sibling.atsType : detected.atsType,
        atsTenant: sibling.atsTenant ?? detected.atsIdentifier ?? null,
        score: similarity,
      };
    }
  }

  if (bestSibling && bestSibling.score >= 0.45) {
    const now = new Date();
    await prisma.job.update({
      where: { id: job.id },
      data: {
        officialApplicationUrl: bestSibling.url,
        officialApplyUrl: bestSibling.url,
        url: bestSibling.url,
        officialJobUrl: bestSibling.url,
        resolutionStatus: "RESOLVED",
        resolutionMethod: "supported_ats",
        resolutionError: null,
        resolvedAt: now,
        verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
        verificationMethod: "company-ats-sibling-match",
        verificationReason: `Matched employer's official ${bestSibling.atsType.toUpperCase()} posting automatically.`,
        lastVerifiedAt: now,
        atsType: bestSibling.atsType,
        atsTenant: bestSibling.atsTenant,
      },
    });
    return {
      resolved: true,
      url: bestSibling.url,
      atsType: bestSibling.atsType,
      method: "company_sibling_job",
    };
  }

  // 3. Query the company's known live ATS board (Greenhouse / Lever / Ashby) if configured
  const companies = await prisma.company.findMany({
    select: { name: true, atsType: true, atsIdentifier: true },
  });
  const matchingCompany = companies.find(
    (c) => normalizeCompanyMatchKey(c.name) === targetCompanyKey && c.atsType && c.atsIdentifier,
  );
  const boardSource = matchingCompany
    ? { atsType: matchingCompany.atsType!, atsIdentifier: matchingCompany.atsIdentifier! }
    : bestSibling?.atsTenant && ["greenhouse", "lever", "ashby"].includes(bestSibling.atsType)
      ? { atsType: bestSibling.atsType, atsIdentifier: bestSibling.atsTenant }
      : null;

  if (boardSource) {
    const livePostings = await searchLivePublicBoard(boardSource.atsType, boardSource.atsIdentifier);
    let bestLive: (BoardCandidate & { score: number }) | null = null;
    for (const candidate of livePostings) {
      const sim = scoreTitleSimilarity(job.title, candidate.title);
      if (!bestLive || sim > bestLive.score) {
        bestLive = { ...candidate, score: sim };
      }
    }
    if (bestLive && bestLive.score >= 0.45 && isValidOfficialApplicationUrl(bestLive.url)) {
      const now = new Date();
      await prisma.job.update({
        where: { id: job.id },
        data: {
          officialApplicationUrl: bestLive.url,
          officialApplyUrl: bestLive.url,
          url: bestLive.url,
          officialJobUrl: bestLive.url,
          resolutionStatus: "RESOLVED",
          resolutionMethod: "supported_ats",
          resolutionError: null,
          resolvedAt: now,
          verificationStatus: "VERIFIED_OFFICIAL_AT_LAST_CHECK",
          verificationMethod: "company-live-ats-board",
          verificationReason: `Located official ${bestLive.atsType.toUpperCase()} posting directly on employer board.`,
          lastVerifiedAt: now,
          atsType: bestLive.atsType,
          atsTenant: bestLive.atsTenant ?? null,
        },
      });
      return {
        resolved: true,
        url: bestLive.url,
        atsType: bestLive.atsType,
        method: "company_live_board",
      };
    }
  }

  return {
    resolved: false,
    url: stored ?? job.sourceUrl ?? null,
    atsType: job.atsType ?? null,
    method: "unresolved",
  };
}
