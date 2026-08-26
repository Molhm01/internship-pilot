import { prisma } from "@/lib/db";
import { AVAILABILITY } from "@/lib/jobs/verificationModel";

export type AvailabilityProbe = {
  state: "open" | "closed" | "unknown";
  status: number | null;
  finalUrl: string;
  reason: string;
};

/**
 * Refuses a match that sits inside a conditional clause.
 *
 * Live postings carry footer boilerplate like "If a job is no longer available,
 * search our other openings" — a hypothetical about some other posting, not a
 * statement about this one. Reading it as a closure signal marks an open
 * internship Closed, which is the one direction this detector must never fail
 * in: a missed closure is corrected on the next check, a false closure removes
 * a real job from the feed.
 */
const CONDITIONAL_LEAD = String.raw`(?<!\b(?:if|when|once|should|unless|whether|in case)\b[^.]{0,60})`;

const CLOSED_TEXT_PATTERNS = [
  // "This/the <posting> is|has been closed" — stated about this posting.
  new RegExp(`${CONDITIONAL_LEAD}\\b(?:this|the)\\s+(?:job|position|posting|requisition)\\s+(?:is|has been)\\s+(?:closed|filled|expired|removed|cancelled|canceled|no longer available)\\b`, "i"),
  new RegExp(`${CONDITIONAL_LEAD}\\bjob\\s+posting\\s+(?:has\\s+)?expired\\b`, "i"),
  new RegExp(`${CONDITIONAL_LEAD}\\bposition\\s+has\\s+been\\s+filled\\b`, "i"),
  // Deliberately no bare "job is no longer available": without a "this"/"the"
  // naming the posting, the phrase is almost always the footer boilerplate
  // above. The determiner form is already covered by the first pattern.
  /\bwe(?:'|’)re\s+sorry[^.]{0,120}\b(?:job|position)\b[^.]{0,120}\bno\s+longer\s+available\b/i,
] as const;

export function looksClosedHtml(html: string): boolean {
  const sample = html.slice(0, 750_000);
  return CLOSED_TEXT_PATTERNS.some((pattern) => pattern.test(sample));
}

export async function probeOfficialJobAvailability(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AvailabilityProbe> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
      headers: { "user-agent": "Mozilla/5.0 Internship-Pilot/1.0" },
    });
    const finalUrl = response.url || url;

    if (response.status === 404 || response.status === 410) {
      return {
        state: "closed",
        status: response.status,
        finalUrl,
        reason: `Official posting returned HTTP ${response.status}.`,
      };
    }

    if (response.status >= 200 && response.status < 300) {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("html") || contentType.includes("text")) {
        const html = await response.text();
        if (looksClosedHtml(html)) {
          return {
            state: "closed",
            status: response.status,
            finalUrl,
            reason: "Official posting explicitly says the job is closed, expired, filled, removed, or no longer available.",
          };
        }
      }
      return {
        state: "open",
        status: response.status,
        finalUrl,
        reason: "Official posting is reachable and does not contain a confirmed closed/expired signal.",
      };
    }

    return {
      state: "unknown",
      status: response.status,
      finalUrl,
      reason: `Official posting returned HTTP ${response.status}; treating availability as unknown rather than closed.`,
    };
  } catch {
    return {
      state: "unknown",
      status: null,
      finalUrl: url,
      reason: "Official posting could not be reached during this check; leaving its prior state unchanged.",
    };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

// Age-bucket backoff (database-usage repair, pass #2): without a floor, a
// small active catalog gets fully re-verified on every tick forever, which
// is wasted work for a posting that was just confirmed open minutes ago.
// Recent postings still get no floor at all — they are the ones most likely
// to be filled or pulled quickly, so they should surface to the front of
// this query as often as the tick allows. Older, more stable postings get a
// floor that grows with age, so this query naturally spends its `take`
// budget on jobs that actually need re-checking.
const RECENT_POSTING_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000; // <7d old: no floor
const MID_AGE_POSTING_CUTOFF_MS = 21 * 24 * 60 * 60 * 1000; // 7-21d old: 6h floor
const MID_AGE_RECHECK_FLOOR_MS = 6 * 60 * 60 * 1000;
const STABLE_RECHECK_FLOOR_MS = 24 * 60 * 60 * 1000; // >21d old: 24h floor

export async function runFreshnessVerificationBatch(
  limit = 10,
): Promise<{ checked: number; open: number; closed: number; unknown: number }> {
  const now = new Date();
  const recentCutoff = new Date(now.getTime() - RECENT_POSTING_CUTOFF_MS);
  const midAgeCutoff = new Date(now.getTime() - MID_AGE_POSTING_CUTOFF_MS);
  const midAgeFloor = new Date(now.getTime() - MID_AGE_RECHECK_FLOOR_MS);
  const stableFloor = new Date(now.getTime() - STABLE_RECHECK_FLOOR_MS);

  const jobs = await prisma.job.findMany({
    where: {
      activeFeed: true,
      verificationStatus: AVAILABILITY.OFFICIAL_VERIFIED,
      officialApplicationUrl: { not: null },
      OR: [
        // Recent posting (or unknown posted date): eligible every tick.
        { OR: [{ sourcePostedAt: null }, { sourcePostedAt: { gte: recentCutoff } }] },
        // Mid-age posting: re-verify at most every 6h.
        {
          sourcePostedAt: { lt: recentCutoff, gte: midAgeCutoff },
          OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lt: midAgeFloor } }],
        },
        // Stable/older posting: re-verify at most every 24h.
        {
          sourcePostedAt: { lt: midAgeCutoff },
          OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lt: stableFloor } }],
        },
      ],
    },
    orderBy: [
      { lastVerifiedAt: { sort: "asc", nulls: "first" } },
      { sourcePostedAt: { sort: "asc", nulls: "first" } },
    ],
    take: Math.max(1, Math.min(limit, 50)),
    select: {
      id: true,
      title: true,
      company: true,
      officialApplicationUrl: true,
    },
  });

  const outcomes = await mapWithConcurrency(jobs, 8, async (job) => {
    const probe = await probeOfficialJobAvailability(job.officialApplicationUrl!);
    const now = new Date();

    if (probe.state === "closed") {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          verificationStatus: AVAILABILITY.CLOSED_CONFIRMED,
          reasonCode: probe.status === 404 || probe.status === 410 ? "CLOSED_NOT_FOUND" : "CLOSED_EXPIRED",
          verificationReason: probe.reason,
          lastVerifiedAt: now,
          httpStatusAtVerification: probe.status,
          activeFeed: false,
          classification: "CONFIRMED_CLOSED",
          classificationReason: probe.reason,
        },
      });
      return "closed" as const;
    }

    if (probe.state === "open") {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          verificationStatus: AVAILABILITY.OFFICIAL_VERIFIED,
          reasonCode: "OFFICIAL_VERIFIED",
          verificationReason: `Official posting rechecked and reachable at ${now.toISOString()}.`,
          lastVerifiedAt: now,
          httpStatusAtVerification: probe.status,
        },
      });
      return "open" as const;
    }

    return "unknown" as const;
  });

  return {
    checked: outcomes.length,
    open: outcomes.filter((outcome) => outcome === "open").length,
    closed: outcomes.filter((outcome) => outcome === "closed").length,
    unknown: outcomes.filter((outcome) => outcome === "unknown").length,
  };
}
