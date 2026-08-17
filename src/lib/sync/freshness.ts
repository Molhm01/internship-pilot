import { prisma } from "@/lib/db";
import { AVAILABILITY } from "@/lib/jobs/verificationModel";

export type AvailabilityProbe = {
  state: "open" | "closed" | "unknown";
  status: number | null;
  finalUrl: string;
  reason: string;
};

const CLOSED_TEXT_PATTERNS = [
  /\bthis\s+(?:job|position|posting|requisition)\s+(?:is|has been)\s+(?:closed|filled|expired|removed|cancelled|canceled|no longer available)\b/i,
  /\bthe\s+(?:job|position|posting|requisition)\s+(?:is|has been)\s+(?:closed|filled|expired|removed|cancelled|canceled|no longer available)\b/i,
  /\bjob\s+posting\s+(?:has\s+)?expired\b/i,
  /\bposition\s+has\s+been\s+filled\b/i,
  /\bjob\s+is\s+no\s+longer\s+available\b/i,
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

export async function runFreshnessVerificationBatch(
  limit = 10,
): Promise<{ checked: number; open: number; closed: number; unknown: number }> {
  const jobs = await prisma.job.findMany({
    where: {
      activeFeed: true,
      verificationStatus: AVAILABILITY.OFFICIAL_VERIFIED,
      officialApplicationUrl: { not: null },
    },
    orderBy: [{ lastVerifiedAt: "asc" }, { sourcePostedAt: "asc" }],
    take: Math.max(1, Math.min(limit, 50)),
    select: {
      id: true,
      title: true,
      company: true,
      officialApplicationUrl: true,
    },
  });

  const outcomes = await mapWithConcurrency(jobs, 4, async (job) => {
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
