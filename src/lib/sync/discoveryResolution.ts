import { prisma } from "@/lib/db";
import { type CompanyForListing } from "@/lib/ats";
import type { AtsJob } from "@/lib/ats/types";
import {
  destinationPersistenceData,
  isAggregatorUrl,
  resolveOfficialJobDestination,
  type DestinationResolution,
} from "@/lib/applications/officialDestination";
import { promoteCanonicalDirectJob } from "@/lib/jobs/activeFeed";
import { isTrustedAggregatorSource } from "@/lib/jobs/sourcePolicy";
import { canonicalizeJobUrl, upsertClassifiedAtsJob } from "@/lib/sync/ingest";
import {
  fetchEngineeringInternships,
  type RawInternListJob,
} from "@/lib/sync/internListAdapter";
import { isTargetEngineeringRole } from "@/lib/sync/classify";
import { probeOfficialJobAvailability } from "@/lib/sync/freshness";
import { findOfficialBoardMatch } from "@/lib/sync/officialBoardMatch";

export type ResolvedSource = {
  source: string;
  atsType: string;
  atsTenant: string;
};

function hostEndsWith(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function firstPathSegment(url: URL): string | null {
  return url.pathname.split("/").filter(Boolean)[0] ?? null;
}

export function inferResolvedSource(value: string): ResolvedSource {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const first = firstPathSegment(url);

  if (hostEndsWith(host, "greenhouse.io")) {
    return { source: "greenhouse", atsType: "greenhouse", atsTenant: first ?? host };
  }
  if (hostEndsWith(host, "lever.co")) {
    return { source: "lever", atsType: "lever", atsTenant: first ?? host };
  }
  if (hostEndsWith(host, "ashbyhq.com")) {
    return { source: "ashby", atsType: "ashby", atsTenant: first ?? host };
  }
  if (hostEndsWith(host, "smartrecruiters.com")) {
    return { source: "smartrecruiters", atsType: "smartrecruiters", atsTenant: first ?? host };
  }
  if (hostEndsWith(host, "myworkdayjobs.com")) {
    const tenant = host.slice(0, -".myworkdayjobs.com".length);
    const segments = url.pathname.split("/").filter(Boolean);
    const site = /^[a-z]{2}-[A-Z]{2}$/.test(segments[0] ?? "") ? segments[1] : segments[0];
    return {
      source: "workday",
      atsType: "workday",
      atsTenant: site ? `${tenant}/${site}` : tenant,
    };
  }
  if (hostEndsWith(host, "icims.com")) {
    return { source: "icims", atsType: "icims", atsTenant: host };
  }
  if (hostEndsWith(host, "taleo.net") || hostEndsWith(host, "oraclecloud.com")) {
    return { source: "taleo", atsType: "taleo", atsTenant: host };
  }
  if (hostEndsWith(host, "successfactors.com") || hostEndsWith(host, "successfactors.eu")) {
    return { source: "successfactors", atsType: "successfactors", atsTenant: host };
  }

  return { source: "other", atsType: "custom", atsTenant: host };
}

type DiscoveryCandidate = {
  storedJobId: string | null;
  sourceJobId: string;
  title: string;
  company: string;
  location: string | null;
  workplaceType: string | null;
  description: string;
  postedAt: Date | null;
  postedAtText: string | null;
  sourceListingUrl: string | null;
  officialApplicationUrl: string | null;
  originalJobPostUrl: string | null;
  internshipTerm: string | null;
  compensation: string | null;
};

function formatInternshipTerm(hireTime: string | null): string | null {
  if (!hireTime) return null;
  const match = hireTime.match(/^(\d{4})-(.+)$/);
  return match ? `${match[2]} ${match[1]}` : hireTime;
}

function liveCandidate(raw: RawInternListJob): DiscoveryCandidate {
  return {
    storedJobId: null,
    sourceJobId: `intern-list:${raw.sourceJobId}`,
    title: raw.title,
    company: raw.company,
    location: raw.location,
    workplaceType: raw.workModel,
    description: raw.qualifications || "",
    postedAt: raw.sourcePostedAt ?? raw.postedAt,
    postedAtText: raw.sourcePostedText,
    sourceListingUrl:
      raw.sourceListingUrl ?? (raw.applyUrl && isAggregatorUrl(raw.applyUrl) ? raw.applyUrl : null),
    officialApplicationUrl: raw.officialApplicationUrl ?? null,
    originalJobPostUrl: raw.originalJobPostUrl ?? null,
    internshipTerm: formatInternshipTerm(raw.hireTime),
    compensation: raw.salary && raw.salary.toUpperCase() !== "N/A" ? raw.salary : null,
  };
}

function companyKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|company|co|holdings|group)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function findCompanyConfig(
  companyName: string,
  companies: CompanyForListing[],
  exactMap: Map<string, CompanyForListing>,
): CompanyForListing | null {
  const key = companyKey(companyName);
  const exact = exactMap.get(key);
  if (exact) return exact;
  if (key.length < 5) return null;

  // Accept a close registry alias only when one normalized company name fully
  // contains the other. The job-title/location matcher still has to pass next.
  return (
    companies.find((company) => {
      const candidate = companyKey(company.name);
      return candidate.length >= 5 && (candidate.includes(key) || key.includes(candidate));
    }) ?? null
  );
}

async function findCanonicalJobId(company: string, officialUrl: string): Promise<string | null> {
  const canonical = canonicalizeJobUrl(officialUrl);
  if (!canonical) return null;
  const rows = await prisma.job.findMany({
    where: { company: { equals: company } },
    select: {
      id: true,
      officialApplicationUrl: true,
      officialApplyUrl: true,
      officialJobUrl: true,
      sourceUrl: true,
      url: true,
    },
  });
  const match = rows.find((row) =>
    [row.officialApplicationUrl, row.officialApplyUrl, row.officialJobUrl, row.sourceUrl, row.url]
      .map(canonicalizeJobUrl)
      .some((candidate) => candidate !== null && candidate === canonical),
  );
  return match?.id ?? null;
}

function destinationFromOfficialBoard(
  candidate: DiscoveryCandidate,
  boardJob: AtsJob,
  now: Date,
): DestinationResolution {
  return {
    sourceListingUrl: candidate.sourceListingUrl,
    officialApplicationUrl: boardJob.applyUrl,
    originalJobPostUrl: boardJob.applyUrl,
    resolutionStatus: "RESOLVED",
    resolutionMethod: "supported_ats",
    resolvedAt: now.toISOString(),
    resolutionError: null,
    redirectChain: [boardJob.applyUrl],
  };
}

async function processCandidate(
  candidate: DiscoveryCandidate,
  company: CompanyForListing | null,
): Promise<"new" | "updated" | "unchanged" | "unresolved" | "closed" | "unknown"> {
  const now = new Date();

  // Highest-value path: use Intern List only as the discovery signal, then ask
  // the employer's own known ATS board for the matching title/location. This
  // does not depend on Jobright/Intern List exposing an "Original Job Post".
  let boardMatch: AtsJob | null = null;
  if (company) {
    try {
      boardMatch = await findOfficialBoardMatch(candidate, company);
    } catch {
      boardMatch = null;
    }
  }

  const destination: DestinationResolution = boardMatch
    ? destinationFromOfficialBoard(candidate, boardMatch, now)
    : await resolveOfficialJobDestination(
        {
          sourceListingUrl: candidate.sourceListingUrl,
          officialApplicationUrl: candidate.officialApplicationUrl,
          originalJobPostUrl: candidate.originalJobPostUrl,
          employerCareerUrl: company?.careersUrl ?? null,
        },
        fetch,
        now,
        { followSourceListings: true },
      );

  if (destination.resolutionStatus !== "RESOLVED" || !destination.officialApplicationUrl) {
    if (candidate.storedJobId) {
      await prisma.job.update({
        where: { id: candidate.storedJobId },
        data: destinationPersistenceData(destination),
      });
    }
    return "unresolved";
  }

  const availability = await probeOfficialJobAvailability(destination.officialApplicationUrl);
  if (availability.state !== "open") {
    if (candidate.storedJobId) {
      await prisma.job.update({
        where: { id: candidate.storedJobId },
        data: {
          ...destinationPersistenceData(destination),
          ...(availability.state === "closed"
            ? {
                verificationStatus: "Closed",
                reasonCode:
                  availability.status === 404 || availability.status === 410
                    ? "CLOSED_NOT_FOUND"
                    : "CLOSED_EXPIRED",
                verificationReason: availability.reason,
                classification: "CONFIRMED_CLOSED",
                classificationReason: availability.reason,
                activeFeed: false,
                lastVerifiedAt: now,
                httpStatusAtVerification: availability.status,
              }
            : {}),
        },
      });
    }
    return availability.state;
  }

  const resolved = inferResolvedSource(destination.officialApplicationUrl);
  const atsJob: AtsJob = boardMatch
    ? {
        ...boardMatch,
        company: candidate.company,
        postedAt: boardMatch.postedAt ?? candidate.postedAt,
        postedAtText: boardMatch.postedAtText ?? candidate.postedAtText,
      }
    : {
        sourceJobId: candidate.sourceJobId,
        requisitionId: null,
        title: candidate.title,
        company: candidate.company,
        location: candidate.location,
        workplaceType: candidate.workplaceType,
        applyUrl: destination.officialApplicationUrl,
        description: candidate.description,
        postedAt: candidate.postedAt,
        postedAtText: candidate.postedAtText,
      };

  const upsertResult = await upsertClassifiedAtsJob({
    job: atsJob,
    source: resolved.source,
    atsType: resolved.atsType,
    atsTenant: resolved.atsTenant,
    classification: "QUALIFYING_INTERNSHIP",
    classificationReason:
      "Discovered through Intern List and independently matched to a live original employer/ATS posting.",
    now,
  });

  await promoteCanonicalDirectJob(atsJob, resolved.source, resolved.atsTenant);

  const canonicalJobId = await findCanonicalJobId(candidate.company, destination.officialApplicationUrl);
  if (canonicalJobId) {
    await prisma.job.update({
      where: { id: canonicalJobId },
      data: {
        discoverySource: "intern-list",
        sourceListingUrl: candidate.sourceListingUrl,
        officialApplicationUrl: destination.officialApplicationUrl,
        officialApplyUrl: destination.officialApplicationUrl,
        url: destination.officialApplicationUrl,
        originalJobPostUrl: destination.originalJobPostUrl ?? destination.officialApplicationUrl,
        officialJobUrl: destination.originalJobPostUrl ?? destination.officialApplicationUrl,
        resolutionStatus: "RESOLVED",
        resolutionMethod: destination.resolutionMethod,
        resolvedAt: now,
        resolutionError: null,
        redirectChain: JSON.stringify(destination.redirectChain),
        internshipTerm: candidate.internshipTerm,
        compensation: candidate.compensation,
        lastVerifiedAt: now,
        httpStatusAtVerification: availability.status,
        activeFeed: true,
      },
    });
  }

  return upsertResult;
}

export async function runInternListOriginalSourceDiscovery(
  limit = 20,
): Promise<{
  examined: number;
  resolved: number;
  unresolved: number;
  closed: number;
  unknown: number;
  newCount: number;
  updatedCount: number;
}> {
  const boundedLimit = Math.max(1, Math.min(limit, 50));
  const { jobs: liveJobs } = await fetchEngineeringInternships();
  const relevantLive = liveJobs.filter((job) => isTargetEngineeringRole(job.title, job.qualifications));

  const sourceUrls = relevantLive
    .map((job) =>
      job.sourceListingUrl ?? (job.applyUrl && isAggregatorUrl(job.applyUrl) ? job.applyUrl : null),
    )
    .filter((value): value is string => Boolean(value));
  const alreadyPromoted = sourceUrls.length
    ? await prisma.job.findMany({
        where: { activeFeed: true, sourceListingUrl: { in: sourceUrls } },
        select: { sourceListingUrl: true },
      })
    : [];
  const promotedUrls = new Set(alreadyPromoted.map((job) => job.sourceListingUrl).filter(Boolean));

  const liveCandidates = relevantLive
    .filter((job) => {
      const sourceUrl =
        job.sourceListingUrl ?? (job.applyUrl && isAggregatorUrl(job.applyUrl) ? job.applyUrl : null);
      return !sourceUrl || !promotedUrls.has(sourceUrl);
    })
    .map(liveCandidate);

  const backlogRows = await prisma.job.findMany({
    where: { activeFeed: false, sourceListingUrl: { not: null } },
    orderBy: [{ sourcePostedAt: "desc" }, { firstSeenAt: "desc" }],
    take: 250,
    select: {
      id: true,
      source: true,
      sourceJobId: true,
      title: true,
      company: true,
      location: true,
      workplaceType: true,
      description: true,
      sourcePostedAt: true,
      sourcePostedText: true,
      sourceListingUrl: true,
      officialApplicationUrl: true,
      originalJobPostUrl: true,
      internshipTerm: true,
      compensation: true,
    },
  });
  const backlogCandidates: DiscoveryCandidate[] = backlogRows
    .filter((job) => isTrustedAggregatorSource(job.source))
    .filter((job) => isTargetEngineeringRole(job.title, job.description))
    .map((job) => ({
      storedJobId: job.id,
      sourceJobId: `aggregator:${job.sourceJobId || job.id}`,
      title: job.title,
      company: job.company,
      location: job.location,
      workplaceType: job.workplaceType,
      description: job.description,
      postedAt: job.sourcePostedAt,
      postedAtText: job.sourcePostedText,
      sourceListingUrl: job.sourceListingUrl,
      officialApplicationUrl: job.officialApplicationUrl,
      originalJobPostUrl: job.originalJobPostUrl,
      internshipTerm: job.internshipTerm,
      compensation: job.compensation,
    }));

  const candidates: DiscoveryCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of [...liveCandidates, ...backlogCandidates]) {
    const key =
      candidate.sourceListingUrl ?? `${candidate.company}|${candidate.title}|${candidate.location ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
    if (candidates.length >= boundedLimit) break;
  }

  const companies: CompanyForListing[] = await prisma.company.findMany({
    where: { allowlisted: true, monitoringStatus: "active" },
    select: {
      name: true,
      atsType: true,
      atsIdentifier: true,
      careersUrl: true,
      lastETag: true,
      lastModified: true,
      contentHash: true,
    },
  });
  const companyMap = new Map<string, CompanyForListing>();
  for (const company of companies) {
    const key = companyKey(company.name);
    if (key && !companyMap.has(key)) companyMap.set(key, company);
  }

  const outcomes: Array<Awaited<ReturnType<typeof processCandidate>>> = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const index = cursor++;
      const candidate = candidates[index]!;
      const company = findCompanyConfig(candidate.company, companies, companyMap);
      outcomes[index] = await processCandidate(candidate, company);
    }
  });
  await Promise.all(workers);

  return {
    examined: outcomes.length,
    resolved: outcomes.filter((outcome) => ["new", "updated", "unchanged"].includes(outcome)).length,
    unresolved: outcomes.filter((outcome) => outcome === "unresolved").length,
    closed: outcomes.filter((outcome) => outcome === "closed").length,
    unknown: outcomes.filter((outcome) => outcome === "unknown").length,
    newCount: outcomes.filter((outcome) => outcome === "new").length,
    updatedCount: outcomes.filter((outcome) => outcome === "updated").length,
  };
}
