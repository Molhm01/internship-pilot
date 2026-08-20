import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { isAggregatorUrl } from "@/lib/applications/officialDestination";
import { hasUsableJobDescription } from "@/lib/matchWorkflow";

const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 2_000_000;
const RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; InternshipPilot/1.0; +https://github.com/Molhm01/internship-pilot)";

const JOB_TEXT_SIGNAL =
  /\b(responsibilit(?:y|ies)|qualifications?|requirements?|experience|skills?|duties|about the role|what you(?:'|’)ll do|what you bring|job description)\b/i;

export type DescriptionHydrationResult = {
  considered: number;
  attempted: number;
  hydrated: number;
  failed: number;
  skippedCooldown: number;
};

type HydrationJob = {
  id: string;
  title: string;
  company: string;
  description: string;
  jobResponsibilities: string | null;
  jobQualifications: string | null;
  officialJobUrl: string | null;
  originalJobPostUrl: string | null;
  officialApplicationUrl: string | null;
  officialApplyUrl: string | null;
  url: string | null;
  resolutionStatus: string;
  verificationStatus: string;
  atsType: string | null;
  atsTenant: string | null;
  sourceJobId: string | null;
  scoringError: string | null;
  scoringQueuedAt: Date | null;
};

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function visibleText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(p|div|li|section|article|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function privateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = host.match(/^172\.(\d+)\./);
  if (match) {
    const second = Number(match[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return host === "0.0.0.0" || host === "::1";
}

function usableOfficialUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || privateHostname(url.hostname) || isAggregatorUrl(url.toString())) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .match(/[a-z0-9+#.]{3,}/g)
    ?.filter((token) => !["intern", "internship", "summer", "engineer", "engineering"].includes(token))
    .slice(0, 6) ?? [];
}

function looksLikeJobPosting(text: string, job: Pick<HydrationJob, "title" | "company">): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length < 180) return false;
  if (JOB_TEXT_SIGNAL.test(normalized)) return true;
  const lower = normalized.toLowerCase();
  const tokens = titleTokens(job.title);
  const titleHits = tokens.filter((token) => lower.includes(token)).length;
  return titleHits >= Math.min(2, Math.max(1, tokens.length))
    && lower.includes(job.company.toLowerCase().split(/\s+/)[0] ?? "");
}

async function fetchText(url: string): Promise<string | null> {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "user-agent": USER_AGENT,
    },
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const raw = (await response.text()).slice(0, MAX_HTML_BYTES);
  const contentType = response.headers.get("content-type") ?? "";
  if (/json/i.test(contentType)) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return JSON.stringify(parsed);
    } catch {
      return raw;
    }
  }
  return visibleText(raw);
}

async function greenhouseDescription(job: HydrationJob): Promise<string | null> {
  if (!job.atsTenant || !job.sourceJobId || !/^\d+$/.test(job.sourceJobId)) return null;
  const response = await fetch(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(job.atsTenant)}/jobs/${encodeURIComponent(job.sourceJobId)}`,
    { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" },
  );
  if (!response.ok) return null;
  const data = await response.json() as { content?: string };
  return data.content ? visibleText(data.content) : null;
}

function leverParts(rawUrl: string): { tenant: string; postingId: string } | null {
  try {
    const url = new URL(rawUrl);
    if (!/(^|\.)jobs(?:\.eu)?\.lever\.co$/i.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { tenant: parts[0], postingId: parts[1] };
  } catch {
    return null;
  }
}

async function leverDescription(rawUrl: string): Promise<string | null> {
  const parts = leverParts(rawUrl);
  if (!parts) return null;
  const response = await fetch(
    `https://api.lever.co/v0/postings/${encodeURIComponent(parts.tenant)}/${encodeURIComponent(parts.postingId)}`,
    { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" },
  );
  if (!response.ok) return null;
  const posting = await response.json() as {
    descriptionPlain?: string;
    openingPlain?: string;
    descriptionBodyPlain?: string;
    additionalPlain?: string;
    lists?: Array<{ text?: string; content?: string }>;
  };
  return [
    posting.openingPlain,
    posting.descriptionPlain,
    posting.descriptionBodyPlain,
    ...(posting.lists ?? []).map((section) => `${section.text ?? ""}\n${visibleText(section.content ?? "")}`),
    posting.additionalPlain,
  ].filter(Boolean).join("\n\n").trim() || null;
}

async function ashbyDescription(job: HydrationJob): Promise<string | null> {
  if (!job.atsTenant || !job.sourceJobId) return null;
  const response = await fetch(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(job.atsTenant)}`,
    { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" },
  );
  if (!response.ok) return null;
  const data = await response.json() as { jobs?: Array<{ id?: string; descriptionPlain?: string }> };
  const posting = data.jobs?.find((item) => item.id === job.sourceJobId);
  return posting?.descriptionPlain?.trim() || null;
}

async function smartRecruitersDescription(job: HydrationJob): Promise<string | null> {
  if (!job.atsTenant || !job.sourceJobId) return null;
  const response = await fetch(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(job.atsTenant)}/postings/${encodeURIComponent(job.sourceJobId)}`,
    { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" },
  );
  if (!response.ok) return null;
  const data = await response.json() as {
    jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
  };
  const sections = Object.values(data.jobAd?.sections ?? {});
  return sections
    .map((section) => `${section.title ?? ""}\n${visibleText(section.text ?? "")}`.trim())
    .filter(Boolean)
    .join("\n\n") || null;
}

async function fetchBestDescription(job: HydrationJob, officialUrl: string): Promise<string | null> {
  const ats = job.atsType?.toLowerCase() ?? "";
  const specific =
    ats === "greenhouse" ? await greenhouseDescription(job)
      : ats === "lever" ? await leverDescription(officialUrl)
        : ats === "ashby" ? await ashbyDescription(job)
          : ats === "smartrecruiters" ? await smartRecruitersDescription(job)
            : await leverDescription(officialUrl);

  if (specific && looksLikeJobPosting(specific, job)) return specific;
  const generic = await fetchText(officialUrl);
  return generic && looksLikeJobPosting(generic, job) ? generic : null;
}

function recentlyFailed(job: HydrationJob, now: Date): boolean {
  return Boolean(
    job.scoringError?.startsWith("DESCRIPTION_")
    && job.scoringQueuedAt
    && now.getTime() - job.scoringQueuedAt.getTime() < RETRY_COOLDOWN_MS,
  );
}

async function hydrateOne(job: HydrationJob, now: Date): Promise<boolean> {
  const officialUrl = [
    job.officialJobUrl,
    job.originalJobPostUrl,
    job.officialApplicationUrl,
    job.officialApplyUrl,
    job.url,
  ].map(usableOfficialUrl).find(Boolean) ?? null;

  if (!officialUrl || (job.resolutionStatus !== "RESOLVED" && job.verificationStatus !== "VERIFIED_OFFICIAL_AT_LAST_CHECK")) {
    await prisma.job.update({
      where: { id: job.id },
      data: {
        scoringState: "DESCRIPTION_PENDING",
        scoringError: "DESCRIPTION_OFFICIAL_URL_UNAVAILABLE",
        scoringQueuedAt: now,
      },
    });
    return false;
  }

  try {
    const description = await fetchBestDescription(job, officialUrl);
    if (!description || !hasUsableJobDescription(description)) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          scoringState: "DESCRIPTION_PENDING",
          scoringError: "DESCRIPTION_FETCH_INSUFFICIENT",
          scoringQueuedAt: now,
        },
      });
      return false;
    }

    await prisma.job.update({
      where: { id: job.id },
      data: {
        description,
        jobDescriptionSourceUrl: officialUrl,
        jobDescriptionCapturedAt: now,
        jobDescriptionHash: createHash("sha256").update(description).digest("hex"),
        scoringState: "NOT_SCORED",
        scoringError: null,
        scoringQueuedAt: null,
      },
    });
    return true;
  } catch (error) {
    console.warn("[description-hydration] official job description fetch failed", {
      jobId: job.id,
      errorCode: error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : error instanceof Error ? error.name : "DESCRIPTION_FETCH_FAILED",
    });
    await prisma.job.update({
      where: { id: job.id },
      data: {
        scoringState: "DESCRIPTION_PENDING",
        scoringError: "DESCRIPTION_FETCH_FAILED",
        scoringQueuedAt: now,
      },
    }).catch(() => undefined);
    return false;
  }
}

/**
 * Bounded, cloud-safe description enrichment that runs before each hosted ATS
 * scoring sweep. It never scores from a title alone: jobs without enough text
 * stay in DESCRIPTION_PENDING until an official employer/ATS page can supply a
 * real job description.
 */
export async function hydrateMissingDescriptionsForScoring(options: {
  maxItems?: number;
  concurrency?: number;
} = {}): Promise<DescriptionHydrationResult> {
  const maxItems = Math.max(1, Math.min(40, Math.trunc(options.maxItems ?? 16)));
  const concurrency = Math.max(1, Math.min(6, Math.trunc(options.concurrency ?? 4)));
  const now = new Date();

  const active = await prisma.job.findMany({
    where: { activeFeed: true },
    orderBy: [{ sourcePostedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      title: true,
      company: true,
      description: true,
      jobResponsibilities: true,
      jobQualifications: true,
      officialJobUrl: true,
      originalJobPostUrl: true,
      officialApplicationUrl: true,
      officialApplyUrl: true,
      url: true,
      resolutionStatus: true,
      verificationStatus: true,
      atsType: true,
      atsTenant: true,
      sourceJobId: true,
      scoringError: true,
      scoringQueuedAt: true,
    },
  });

  const missing = active.filter((job) => !hasUsableJobDescription(job));
  let skippedCooldown = 0;
  const candidates: HydrationJob[] = [];
  for (const job of missing) {
    if (recentlyFailed(job, now)) {
      skippedCooldown += 1;
      continue;
    }
    candidates.push(job);
    if (candidates.length >= maxItems) break;
  }

  let nextIndex = 0;
  let hydrated = 0;
  let failed = 0;
  const worker = async () => {
    while (nextIndex < candidates.length) {
      const index = nextIndex;
      nextIndex += 1;
      const ok = await hydrateOne(candidates[index], now);
      if (ok) hydrated += 1;
      else failed += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length || 1) }, () => worker()));

  return {
    considered: missing.length,
    attempted: candidates.length,
    hydrated,
    failed,
    skippedCooldown,
  };
}
