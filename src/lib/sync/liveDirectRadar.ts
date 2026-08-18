import { prisma } from "@/lib/db";
import type { AtsJob } from "@/lib/ats/types";
import { promoteCanonicalDirectJob } from "@/lib/jobs/activeFeed";
import { inferResolvedSource } from "@/lib/sync/discoveryResolution";
import {
  fetchMassTechnicalCandidates,
  type MassFeedCandidate,
} from "@/lib/sync/massTechnicalFeeds";
import {
  fetchExpandedDirectCandidates,
  type ExpandedDirectCandidate,
} from "@/lib/sync/publicDirectFeedsExpanded";
import { canonicalizeJobUrl, upsertClassifiedAtsJob } from "@/lib/sync/ingest";

const RADAR_CURSOR_KEY = "liveDiscovery:cursor:direct-radar";
const LIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type DirectRadarCandidate = {
  discoverySource: "simplify" | "zapply" | "applyguy" | "dreamwork";
  sourceJobId: string;
  title: string;
  company: string;
  location: string | null;
  workplaceType: string | null;
  postedAt: Date;
  postedAtText: string | null;
  officialUrl: string;
};

type DirectRadarCursor = {
  version: 1;
  lastCheckedAt: string;
  latestSourcePostedAt: string | null;
  sourceCounts: Record<string, number>;
  recentCandidates: number;
};

function normalizeMass(candidate: MassFeedCandidate): DirectRadarCandidate | null {
  if (!candidate.postedAt) return null;
  return {
    discoverySource: candidate.discoverySource,
    sourceJobId: candidate.sourceJobId,
    title: candidate.title,
    company: candidate.company,
    location: candidate.location,
    workplaceType: null,
    postedAt: candidate.postedAt,
    postedAtText: candidate.postedAtText,
    officialUrl: candidate.officialUrl,
  };
}

function normalizeExpanded(candidate: ExpandedDirectCandidate): DirectRadarCandidate | null {
  if (!candidate.postedAt) return null;
  return {
    discoverySource: candidate.discoverySource,
    sourceJobId: candidate.sourceJobId,
    title: candidate.title,
    company: candidate.company,
    location: candidate.location,
    workplaceType: candidate.workplaceType,
    postedAt: candidate.postedAt,
    postedAtText: candidate.postedAtText,
    officialUrl: candidate.officialUrl,
  };
}

function asAtsJob(candidate: DirectRadarCandidate): AtsJob {
  return {
    sourceJobId: candidate.sourceJobId,
    requisitionId: null,
    title: candidate.title,
    company: candidate.company,
    location: candidate.location,
    workplaceType: candidate.workplaceType,
    applyUrl: candidate.officialUrl,
    description: "",
    postedAt: candidate.postedAt,
    postedAtText: candidate.postedAtText,
  };
}

export async function runLiveDirectRadar(limit = 250): Promise<{
  fetched: number;
  recent: number;
  alreadyActive: number;
  examined: number;
  newCount: number;
  updatedCount: number;
  unchangedCount: number;
  failed: number;
  sourceCounts: Record<string, number>;
  latestSourcePostedAt: string | null;
}> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - LIVE_WINDOW_MS);
  const [mass, expanded] = await Promise.all([
    fetchMassTechnicalCandidates(),
    fetchExpandedDirectCandidates(),
  ]);

  const sourceCounts: Record<string, number> = {
    simplify: mass.simplifyFetched,
    zapply: mass.zapplyFetched,
    applyguy: expanded.applyGuyFetched,
    dreamwork: expanded.dreamworkFetched,
  };

  const seen = new Set<string>();
  const candidates = [
    ...mass.candidates.map(normalizeMass),
    ...expanded.candidates.map(normalizeExpanded),
  ]
    .filter((candidate): candidate is DirectRadarCandidate => Boolean(candidate))
    .filter((candidate) => candidate.postedAt >= cutoff && candidate.postedAt <= now)
    .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime())
    .filter((candidate) => {
      const canonical = canonicalizeJobUrl(candidate.officialUrl) ?? candidate.officialUrl;
      if (seen.has(canonical)) return false;
      seen.add(canonical);
      return true;
    });

  const canonicalUrls = candidates
    .map((candidate) => canonicalizeJobUrl(candidate.officialUrl))
    .filter((value): value is string => Boolean(value));
  const activeRows = canonicalUrls.length
    ? await prisma.job.findMany({
        where: {
          activeFeed: true,
          OR: [
            { officialApplicationUrl: { in: candidates.map((row) => row.officialUrl) } },
            { officialApplyUrl: { in: candidates.map((row) => row.officialUrl) } },
            { url: { in: candidates.map((row) => row.officialUrl) } },
            { sourceJobId: { in: candidates.map((row) => row.sourceJobId) } },
          ],
        },
        select: {
          officialApplicationUrl: true,
          officialApplyUrl: true,
          url: true,
          sourceJobId: true,
        },
      })
    : [];

  const activeUrlKeys = new Set(
    activeRows
      .flatMap((row) => [row.officialApplicationUrl, row.officialApplyUrl, row.url])
      .map((value) => (value ? canonicalizeJobUrl(value) : null))
      .filter((value): value is string => Boolean(value)),
  );
  const activeSourceIds = new Set(activeRows.map((row) => row.sourceJobId).filter(Boolean));
  const unseen = candidates.filter((candidate) => {
    const canonical = canonicalizeJobUrl(candidate.officialUrl);
    return !activeSourceIds.has(candidate.sourceJobId) && (!canonical || !activeUrlKeys.has(canonical));
  });
  const selected = unseen.slice(0, Math.max(1, Math.min(limit, 500)));

  let cursor = 0;
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  let failed = 0;
  const workers = Array.from({ length: Math.min(20, selected.length) }, async () => {
    while (cursor < selected.length) {
      const candidate = selected[cursor++]!;
      const resolved = inferResolvedSource(candidate.officialUrl);
      const job = asAtsJob(candidate);
      try {
        const outcome = await upsertClassifiedAtsJob({
          job,
          source: resolved.source,
          atsType: resolved.atsType,
          atsTenant: resolved.atsTenant,
          classification: "QUALIFYING_INTERNSHIP",
          classificationReason:
            `Live ${candidate.discoverySource} radar supplied a current job-specific original employer/ATS URL.`,
          now,
        });
        await promoteCanonicalDirectJob(job, resolved.source, resolved.atsTenant);
        if (outcome === "new") newCount += 1;
        else if (outcome === "updated") updatedCount += 1;
        else unchangedCount += 1;
      } catch (error) {
        failed += 1;
        console.error("[live-direct-radar] candidate failed", {
          source: candidate.discoverySource,
          company: candidate.company,
          title: candidate.title,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  await Promise.all(workers);

  const latestSourcePostedAt = candidates[0]?.postedAt.toISOString() ?? null;
  const cursorValue: DirectRadarCursor = {
    version: 1,
    lastCheckedAt: now.toISOString(),
    latestSourcePostedAt,
    sourceCounts,
    recentCandidates: candidates.length,
  };
  await prisma.appSetting.upsert({
    where: { key: RADAR_CURSOR_KEY },
    create: { key: RADAR_CURSOR_KEY, value: JSON.stringify(cursorValue) },
    update: { value: JSON.stringify(cursorValue) },
  });

  return {
    fetched:
      mass.simplifyFetched + mass.zapplyFetched + expanded.applyGuyFetched + expanded.dreamworkFetched,
    recent: candidates.length,
    alreadyActive: candidates.length - unseen.length,
    examined: selected.length,
    newCount,
    updatedCount,
    unchangedCount,
    failed,
    sourceCounts,
    latestSourcePostedAt,
  };
}
