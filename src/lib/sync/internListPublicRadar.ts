import {
  INTERN_LIST_SWE_URL,
  parsePublicInternListPage,
  type RawInternListJob,
} from "@/lib/sync/internListAdapter";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Intern List's public Webflow collection uses a generated query parameter
 * ending in `_page`. We discover those links from each fetched page rather
 * than depending on the generated prefix, so a Webflow redeploy does not break
 * pagination.
 */
export function publicInternListPaginationUrls(html: string, pageUrl: string): string[] {
  const urls = new Map<number, string>();
  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const rawHref = match[1];
    if (!rawHref) continue;
    try {
      const url = new URL(decodeHtml(rawHref), pageUrl);
      if (!["intern-list.com", "www.intern-list.com"].includes(url.hostname)) continue;
      if (url.pathname.replace(/\/$/, "") !== "/swe-intern-list") continue;
      for (const [key, value] of url.searchParams.entries()) {
        if (!/(?:^|_)page$/i.test(key)) continue;
        const page = Number.parseInt(value, 10);
        if (Number.isFinite(page) && page > 1 && !urls.has(page)) {
          url.hash = "";
          urls.set(page, url.toString());
        }
      }
    } catch {
      // Ignore malformed/unrelated links.
    }
  }
  return [...urls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, url]) => url);
}

type PageResult = {
  url: string;
  html: string | null;
};

async function fetchPage(url: string): Promise<PageResult> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { url, html: null };
    return { url, html: await response.text() };
  } catch {
    return { url, html: null };
  }
}

export type InternListPublicRadarResult = {
  jobs: RawInternListJob[];
  pagesFetched: number;
  pagesFailed: number;
  maxPagesReached: boolean;
  maxJobsReached: boolean;
};

/**
 * Higher-recall public Intern List radar.
 *
 * The old adapter intentionally stopped after three pages / 300 rows. That was
 * fine as a bootstrap source but not as a Jobright-parity radar. This crawler
 * walks the public pagination graph in small concurrent batches, with hard
 * runtime/volume bounds so it is safe in Vercel. Event-level dedupe and official
 * employer resolution happen in supplementalRadarQueue.ts.
 */
export async function fetchInternListPublicRadar(
  options: {
    maxPages?: number;
    maxJobs?: number;
    concurrency?: number;
    capturedAt?: Date;
  } = {},
): Promise<InternListPublicRadarResult> {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 12, 60));
  const maxJobs = Math.max(1, Math.min(options.maxJobs ?? 1_500, 6_000));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 6, 10));
  const capturedAt = options.capturedAt ?? new Date();

  const queue: string[] = [INTERN_LIST_SWE_URL];
  const queued = new Set(queue);
  const visited = new Set<string>();
  const seenJobs = new Set<string>();
  const jobs: RawInternListJob[] = [];
  let pagesFetched = 0;
  let pagesFailed = 0;

  while (queue.length > 0 && visited.size < maxPages && jobs.length < maxJobs) {
    const remainingPages = maxPages - visited.size;
    const batchSize = Math.min(concurrency, remainingPages, queue.length);
    const batch = queue.splice(0, batchSize);
    for (const url of batch) visited.add(url);

    const results = await Promise.all(batch.map(fetchPage));
    for (const result of results) {
      if (!result.html) {
        pagesFailed += 1;
        continue;
      }
      pagesFetched += 1;

      const parsed = parsePublicInternListPage(
        result.html,
        result.url,
        capturedAt,
        jobs.length,
      );
      for (const job of parsed) {
        const identity = job.sourceJobId || job.sourceListingUrl || `${job.company}|${job.title}`;
        if (seenJobs.has(identity)) continue;
        seenJobs.add(identity);
        jobs.push({ ...job, sourceRowIndex: jobs.length });
        if (jobs.length >= maxJobs) break;
      }

      for (const next of publicInternListPaginationUrls(result.html, result.url)) {
        if (visited.has(next) || queued.has(next)) continue;
        queued.add(next);
        queue.push(next);
      }
    }
  }

  return {
    jobs,
    pagesFetched,
    pagesFailed,
    maxPagesReached: visited.size >= maxPages && queue.length > 0,
    maxJobsReached: jobs.length >= maxJobs,
  };
}
