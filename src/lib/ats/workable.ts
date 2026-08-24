import { fetchJsonRequired, type AtsJob } from "@/lib/ats/types";

/**
 * Workable's public job-board widget API.
 *
 * Unauthenticated, documented, and the same endpoint every Workable-hosted
 * careers page calls to render itself. It returns the employer's real job
 * description and an exact publication date, so postings resolved through it
 * arrive with a genuine JD and a trustworthy timestamp rather than needing
 * later hydration.
 *
 * The live miss dataset put two employers behind this platform (Anthro Energy,
 * LV Collective) whose internships the pipeline could not reach at all.
 */

type WorkableLocation = {
  country?: string | null;
  countryCode?: string | null;
  city?: string | null;
  region?: string | null;
  hidden?: boolean;
};

type WorkableJob = {
  title?: string;
  shortcode?: string;
  code?: string | null;
  employment_type?: string | null;
  telecommuting?: boolean;
  url?: string;
  shortlink?: string;
  application_url?: string;
  published_on?: string;
  created_at?: string;
  country?: string | null;
  city?: string | null;
  state?: string | null;
  description?: string | null;
  locations?: WorkableLocation[];
};

/** "Alameda, California" / "Alameda, CA, United States" as the vendor gives it. */
function locationOf(job: WorkableJob): string | null {
  const primary = job.locations?.find((location) => !location.hidden) ?? job.locations?.[0];
  const city = job.city ?? primary?.city ?? null;
  const region = job.state ?? primary?.region ?? null;
  const country = job.country ?? primary?.country ?? null;
  const parts = [city, region, country].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length > 0 ? parts.join(", ") : null;
}

function plainText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Normalize the widget payload. Exported separately from the fetch so the
 * shape contract is testable without a network call.
 */
export function parseWorkableJobs(
  payload: unknown,
  account: string,
  companyName: string,
): AtsJob[] {
  const data = payload as { jobs?: WorkableJob[] } | null;
  if (!data || !Array.isArray(data.jobs)) return [];

  const jobs: AtsJob[] = [];
  for (const job of data.jobs) {
    const shortcode = job.shortcode?.trim();
    const title = job.title?.trim();
    if (!shortcode || !title) continue;

    // Prefer the vendor's own canonical posting URL; fall back to the shape it
    // is always built from. Never the application_url, which skips the posting.
    const applyUrl =
      job.url?.trim() || job.shortlink?.trim() || `https://apply.workable.com/${account}/j/${shortcode}/`;

    const published = job.published_on ?? job.created_at ?? null;
    const postedAt = published ? new Date(`${published}T00:00:00Z`) : null;

    jobs.push({
      sourceJobId: shortcode,
      requisitionId: job.code?.trim() || null,
      title,
      company: companyName,
      location: locationOf(job),
      workplaceType: job.telecommuting ? "Remote" : null,
      applyUrl,
      description: plainText(job.description),
      postedAt: postedAt && Number.isFinite(postedAt.getTime()) ? postedAt : null,
      postedAtText: published ?? null,
      employmentType: job.employment_type ?? null,
    });
  }
  return jobs;
}

export async function listWorkableJobs(account: string, companyName: string): Promise<AtsJob[]> {
  const payload = await fetchJsonRequired(
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(account)}?details=true`,
    {
      headers: {
        accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    },
    15_000,
  );
  return parseWorkableJobs(payload, account, companyName);
}
