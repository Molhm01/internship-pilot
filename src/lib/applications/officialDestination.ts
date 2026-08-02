const AGGREGATOR_HOSTS = [
  "jobright.ai",
  "intern-list.com",
  "simplify.jobs",
  "linkedin.com",
  "indeed.com",
  "glassdoor.com",
  "ziprecruiter.com",
] as const;

const ATS_HOST_PATTERNS = [
  /(^|\.)greenhouse\.io$/,
  /(^|\.)lever\.co$/,
  /(^|\.)ashbyhq\.com$/,
  /(^|\.)myworkdayjobs\.com$/,
  /(^|\.)icims\.com$/,
  /(^|\.)smartrecruiters\.com$/,
  /(^|\.)oraclecloud\.com$/,
  /(^|\.)taleo\.net$/,
  /(^|\.)successfactors\.(com|eu)$/,
] as const;

export const MAX_DESTINATION_DEPTH = 5;

export type ResolutionStatus = "RESOLVED" | "OFFICIAL_URL_UNRESOLVED";
export type ResolutionMethod =
  | "existing_verified"
  | "original_job_post"
  | "employer_career_site"
  | "supported_ats"
  | "safe_redirect"
  | "jobright_original_job_post"
  | "intern_list_outbound";

export type DestinationJob = {
  verificationStatus?: string | null;
  resolutionStatus?: string | null;
  sourceListingUrl?: string | null;
  officialApplicationUrl?: string | null;
  originalJobPostUrl?: string | null;
  employerCareerUrl?: string | null;
  sourceUrl?: string | null;
  officialApplyUrl?: string | null;
  officialJobUrl?: string | null;
  jobDescriptionSourceUrl?: string | null;
  url?: string | null;
  redirectChain?: string | null;
};

export type DestinationResolution = {
  sourceListingUrl: string | null;
  officialApplicationUrl: string | null;
  originalJobPostUrl: string | null;
  resolutionStatus: ResolutionStatus;
  resolutionMethod: ResolutionMethod | null;
  resolvedAt: string;
  resolutionError: string | null;
  redirectChain: string[];
};

export type ResolvedDestination = DestinationResolution & {
  officialApplicationUrl: string;
  resolutionStatus: "RESOLVED";
  resolutionMethod: ResolutionMethod;
  resolutionError: null;
};

export class OfficialApplicationUrlUnresolvedError extends Error {
  readonly code = "OFFICIAL_APPLICATION_URL_UNRESOLVED";

  constructor(message = "No safe official employer application URL could be resolved.") {
    super(message);
    this.name = "OfficialApplicationUrlUnresolvedError";
  }
}

function parsedWebUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const localhost =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if ((url.protocol !== "https:" && !(localhost && url.protocol === "http:")) ||
        url.username ||
        url.password) {
      return null;
    }
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function isAggregatorUrl(value: string | null | undefined): boolean {
  const url = parsedWebUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return AGGREGATOR_HOSTS.some((candidate) => hostMatches(host, candidate));
}

export function isSupportedAtsUrl(value: string | null | undefined): boolean {
  const url = parsedWebUrl(value);
  if (!url || isAggregatorUrl(value)) return false;
  const host = url.hostname.toLowerCase();
  if (!ATS_HOST_PATTERNS.some((pattern) => pattern.test(host))) return false;

  const path = url.pathname.toLowerCase();
  const hasJobQuery = [...url.searchParams.keys()].some((key) =>
    /^(job|jobid|job_id|req|reqid|requisition|requisitionid)$/.test(key.toLowerCase()),
  );
  if (hostMatches(host, "greenhouse.io")) return /\/jobs?\/[^/]+/.test(path) || hasJobQuery;
  if (hostMatches(host, "lever.co") || hostMatches(host, "ashbyhq.com")) {
    return path.split("/").filter(Boolean).length >= 2;
  }
  if (hostMatches(host, "myworkdayjobs.com")) return /\/job\/[^/]+/.test(path) || hasJobQuery;
  if (hostMatches(host, "icims.com")) return /\/jobs\/[^/]+/.test(path) || hasJobQuery;
  if (hostMatches(host, "smartrecruiters.com")) {
    return path.split("/").filter(Boolean).length >= 2 || hasJobQuery;
  }
  if (hostMatches(host, "oraclecloud.com")) return /\/job\/[^/]+/.test(path) || hasJobQuery;
  if (hostMatches(host, "taleo.net")) return /jobdetail/i.test(path) || hasJobQuery;
  return /\/job\/[^/]+/.test(path) || hasJobQuery;
}

function isForbiddenDestination(url: URL): boolean {
  const path = url.pathname.toLowerCase();
  if (/(^|\/)(login|log-in|signin|sign-in|auth|account)(\/|$)/.test(path)) return true;
  if (/(^|\/)(search|job-search|jobs-search)(\/|$)/.test(path)) return true;
  if ([...url.searchParams.keys()].some((key) => /^(q|query|keyword|search)$/.test(key))) {
    return true;
  }
  return false;
}

export function isEmployerJobUrl(value: string | null | undefined): boolean {
  const url = parsedWebUrl(value);
  if (!url || isAggregatorUrl(value) || isSupportedAtsUrl(value) || isForbiddenDestination(url)) {
    return false;
  }

  const path = url.pathname.replace(/\/+$/, "");
  const hasJobPath =
    /\/(jobs?|careers?\/jobs?|positions?|openings?|opportunities?|vacancies?)\/[^/]+/i.test(path);
  // Employer-hosted ATS boards embed the job identity in a query parameter
  // rather than the path — e.g. "https://motional.com/open-positions/?gh_jid=N"
  // and "https://cannondesign.com/careers/?gh_jid=N". These are job-specific
  // official application pages; omitting the vendor `*_jid` parameters made
  // them look like generic careers landing pages and left real internships
  // with no resolved destination.
  const hasJobQuery = [...url.searchParams.entries()].some(
    ([key, candidate]) =>
      /^(job|jobid|job_id|jid|gh_jid|lever_jid|ashby_jid|req|reqid|requisition|requisitionid)$/i.test(key) &&
      candidate.trim().length > 0,
  );
  return hasJobPath || hasJobQuery;
}

export function isValidOfficialApplicationUrl(
  value: string | null | undefined,
): value is string {
  return isSupportedAtsUrl(value) || isEmployerJobUrl(value);
}

function canonicalUrl(value: string): string {
  return parsedWebUrl(value)?.toString() ?? value;
}

function decodeJsonString(raw: string): string | null {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return null;
  }
}

/**
 * Jobright exposes the employer destination as `originalUrl` and labels its
 * anchor “Original Job Post”. Both representations occur in stored fixtures
 * and live page data.
 */
export function extractOriginalJobPost(html: string, baseUrl: string): string | null {
  const jsonNames = ["originalUrl", "originalJobPostUrl", "originalJobUrl"];
  const candidates: string[] = [];
  for (const name of jsonNames) {
    const match = html.match(new RegExp(`"${name}"\\s*:\\s*"((?:\\\\.|[^"\\\\])+)`, "i"));
    const decoded = match?.[1] ? decodeJsonString(match[1]) : null;
    if (decoded) candidates.push(decoded);
  }
  for (const match of html.matchAll(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?Original\s+Job\s+Post[\s\S]*?<\/a>/gi,
  )) {
    if (match[1]) candidates.push(match[1]);
  }

  for (const candidate of candidates) {
    try {
      const resolved = new URL(candidate, baseUrl).toString();
      if (parsedWebUrl(resolved)) return resolved;
    } catch {
      // Try the next stored representation.
    }
  }
  return null;
}

function extractOutboundDestination(html: string, baseUrl: string): string | null {
  const base = parsedWebUrl(baseUrl);
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) {
    try {
      const candidate = new URL(match[1]!, baseUrl).toString();
      const parsed = parsedWebUrl(candidate);
      if (
        parsed &&
        parsed.toString() !== base?.toString() &&
        (isValidOfficialApplicationUrl(candidate) ||
          (isAggregatorUrl(candidate) && parsed.hostname !== base?.hostname))
      ) {
        return candidate;
      }
    } catch {
      // Ignore malformed outbound links.
    }
  }
  return null;
}

async function fetchOne(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ nextUrl: string | null; html: string | null; status: number }> {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(8_000),
    headers: { "user-agent": "Mozilla/5.0 Internship-Pilot/1.0" },
  });
  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location) {
    return { nextUrl: new URL(location, url).toString(), html: null, status: response.status };
  }
  const contentType = response.headers.get("content-type") ?? "";
  const html = contentType.includes("html") ? await response.text() : null;
  return { nextUrl: null, html, status: response.status };
}

type CandidateResult = {
  officialApplicationUrl: string;
  originalJobPostUrl: string | null;
  redirectChain: string[];
  traversedJobright: boolean;
  traversedInternList: boolean;
};

async function resolveCandidate(
  startUrl: string,
  fetchImpl: typeof fetch,
  followEvenIfFinal = false,
): Promise<{ result: CandidateResult | null; error: string | null }> {
  let current = startUrl;
  let originalJobPostUrl: string | null = null;
  let traversedJobright = false;
  let traversedInternList = false;
  const visited = new Set<string>();
  const redirectChain: string[] = [];

  for (let depth = 0; depth < MAX_DESTINATION_DEPTH; depth += 1) {
    const parsed = parsedWebUrl(current);
    if (!parsed) return { result: null, error: "Destination must be HTTPS." };
    current = parsed.toString();
    if (visited.has(current)) return { result: null, error: "Destination redirect loop detected." };
    visited.add(current);
    redirectChain.push(current);

    const host = parsed.hostname.toLowerCase();
    traversedJobright ||= hostMatches(host, "jobright.ai");
    traversedInternList ||= hostMatches(host, "intern-list.com");

    if (isValidOfficialApplicationUrl(current) && !followEvenIfFinal) {
      return {
        result: {
          officialApplicationUrl: current,
          originalJobPostUrl,
          redirectChain,
          traversedJobright,
          traversedInternList,
        },
        error: null,
      };
    }

    let fetched: Awaited<ReturnType<typeof fetchOne>>;
    try {
      fetched = await fetchOne(current, fetchImpl);
    } catch {
      if (isValidOfficialApplicationUrl(current)) {
        return {
          result: {
            officialApplicationUrl: current,
            originalJobPostUrl,
            redirectChain,
            traversedJobright,
            traversedInternList,
          },
          error: null,
        };
      }
      return { result: null, error: "Destination could not be fetched." };
    }

    if (fetched.status === 404 || fetched.status === 410) {
      return { result: null, error: `Destination returned HTTP ${fetched.status}.` };
    }
    if (fetched.nextUrl) {
      current = fetched.nextUrl;
      followEvenIfFinal = false;
      continue;
    }
    if (isValidOfficialApplicationUrl(current)) {
      return {
        result: {
          officialApplicationUrl: current,
          originalJobPostUrl,
          redirectChain,
          traversedJobright,
          traversedInternList,
        },
        error: null,
      };
    }
    if (!isAggregatorUrl(current) || !fetched.html || fetched.status < 200 || fetched.status >= 300) {
      return { result: null, error: "Destination is not a job-specific employer or ATS page." };
    }

    const original = extractOriginalJobPost(fetched.html, current);
    const outbound =
      original ??
      (hostMatches(host, "intern-list.com")
        ? extractOutboundDestination(fetched.html, current)
        : null);
    if (!outbound) {
      return { result: null, error: "The source listing did not expose an employer destination." };
    }
    if (original && !isAggregatorUrl(original)) originalJobPostUrl = canonicalUrl(original);
    current = outbound;
    followEvenIfFinal = false;
  }

  return {
    result: null,
    error: `Destination resolution exceeded the depth limit of ${MAX_DESTINATION_DEPTH}.`,
  };
}

function firstAggregator(values: Array<string | null | undefined>): string | null {
  const found = values.find((value): value is string => Boolean(value) && isAggregatorUrl(value));
  return found ? canonicalUrl(found) : null;
}

function directResolution(
  job: DestinationJob,
  sourceListingUrl: string | null,
): Omit<ResolvedDestination, "resolvedAt"> | null {
  const verified =
    job.resolutionStatus === "RESOLVED" ||
    job.verificationStatus === "VERIFIED_OFFICIAL_AT_LAST_CHECK";
  if (!verified) return null;
  const candidate = [
    job.officialApplicationUrl,
    job.officialApplyUrl,
    job.url,
  ].find(isValidOfficialApplicationUrl);
  if (!candidate) return null;
  return {
    sourceListingUrl,
    officialApplicationUrl: canonicalUrl(candidate),
    originalJobPostUrl:
      [job.originalJobPostUrl, job.officialJobUrl].find(isValidOfficialApplicationUrl) ?? null,
    resolutionStatus: "RESOLVED",
    resolutionMethod: "existing_verified",
    resolutionError: null,
    redirectChain: [canonicalUrl(candidate)],
  };
}

export async function resolveOfficialJobDestination(
  job: DestinationJob,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
  options: { followSourceListings?: boolean } = {},
): Promise<DestinationResolution> {
  const resolvedAt = now.toISOString();
  const sourceListingUrl =
    firstAggregator([
      job.sourceListingUrl,
      job.sourceUrl,
      job.officialApplicationUrl,
      job.officialApplyUrl,
      job.url,
      job.originalJobPostUrl,
      job.officialJobUrl,
    ]);
  const existing = directResolution(job, sourceListingUrl);
  if (existing) return { ...existing, resolvedAt };

  let lastError = "No destination URL is stored.";
  const attempted = new Set<string>();
  const tryCandidate = async (
    candidate: string | null | undefined,
    method: ResolutionMethod,
    followEvenIfFinal = false,
  ): Promise<DestinationResolution | null> => {
    if (!candidate) return null;
    const parsed = parsedWebUrl(candidate);
    if (!parsed || attempted.has(parsed.toString())) return null;
    attempted.add(parsed.toString());
    const resolved = await resolveCandidate(parsed.toString(), fetchImpl, followEvenIfFinal);
    if (!resolved.result) {
      lastError = resolved.error ?? lastError;
      return null;
    }
    const actualMethod: ResolutionMethod = resolved.result.traversedInternList
      ? "intern_list_outbound"
      : resolved.result.traversedJobright
        ? "jobright_original_job_post"
        : method;
    return {
      sourceListingUrl,
      officialApplicationUrl: resolved.result.officialApplicationUrl,
      originalJobPostUrl:
        resolved.result.originalJobPostUrl ??
        (method === "original_job_post" ? canonicalUrl(candidate) : null),
      resolutionStatus: "RESOLVED",
      resolutionMethod: actualMethod,
      resolvedAt,
      resolutionError: null,
      redirectChain: resolved.result.redirectChain,
    };
  };

  for (const candidate of [job.originalJobPostUrl, job.officialJobUrl]) {
    const resolved = await tryCandidate(candidate, "original_job_post");
    if (resolved) return resolved;
  }

  const employerCandidate = [
    job.employerCareerUrl,
    job.officialApplicationUrl,
    job.officialApplyUrl,
    job.url,
    job.jobDescriptionSourceUrl,
  ].find(isEmployerJobUrl);
  {
    const resolved = await tryCandidate(employerCandidate, "employer_career_site");
    if (resolved) return resolved;
  }

  const atsCandidate = [
    job.officialApplicationUrl,
    job.officialApplyUrl,
    job.url,
    job.jobDescriptionSourceUrl,
    job.sourceUrl,
  ].find(isSupportedAtsUrl);
  {
    const resolved = await tryCandidate(atsCandidate, "supported_ats");
    if (resolved) return resolved;
  }

  for (const candidate of [
    job.officialApplicationUrl,
    job.officialApplyUrl,
    job.url,
    job.employerCareerUrl,
    ...(options.followSourceListings === false ? [] : [sourceListingUrl]),
  ]) {
    const resolved = await tryCandidate(candidate, "safe_redirect", true);
    if (resolved) return resolved;
  }

  return {
    sourceListingUrl,
    officialApplicationUrl: null,
    originalJobPostUrl: null,
    resolutionStatus: "OFFICIAL_URL_UNRESOLVED",
    resolutionMethod: null,
    resolvedAt,
    resolutionError: lastError,
    redirectChain: [],
  };
}

/** Compatibility wrapper for callers that still expect an exception. */
export async function resolveOfficialApplicationDestination(
  job: DestinationJob,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedDestination> {
  const result = await resolveOfficialJobDestination(job, fetchImpl);
  if (
    result.resolutionStatus !== "RESOLVED" ||
    !result.officialApplicationUrl ||
    !result.resolutionMethod
  ) {
    throw new OfficialApplicationUrlUnresolvedError(result.resolutionError ?? undefined);
  }
  return result as ResolvedDestination;
}

export function destinationPersistenceData(result: DestinationResolution) {
  const officialApplicationUrl =
    result.resolutionStatus === "RESOLVED" ? result.officialApplicationUrl : null;
  return {
    sourceListingUrl: result.sourceListingUrl,
    officialApplicationUrl,
    originalJobPostUrl: result.originalJobPostUrl,
    resolutionStatus: result.resolutionStatus,
    resolutionMethod: result.resolutionMethod,
    resolvedAt: new Date(result.resolvedAt),
    resolutionError: result.resolutionError,
    redirectChain: JSON.stringify(result.redirectChain),
    officialApplyUrl: officialApplicationUrl,
    url: officialApplicationUrl,
    officialJobUrl: result.originalJobPostUrl ?? officialApplicationUrl,
  };
}
